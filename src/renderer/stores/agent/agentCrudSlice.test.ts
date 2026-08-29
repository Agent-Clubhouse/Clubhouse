import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCrudSlice } from './agentCrudSlice';
import type { AgentState } from './types';

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
    loadAgentIcon: vi.fn(),
    ...overrides,
  } as unknown as AgentState;
}

function createTestStore(initial: Partial<AgentState> = {}) {
  let state = createMinimalState(initial);
  const set = (
    updater: Partial<AgentState> | ((s: AgentState) => Partial<AgentState> | AgentState),
  ) => {
    const result = typeof updater === 'function' ? updater(state) : updater;
    state = { ...state, ...result };
  };
  const get = () => state;
  const slice = createCrudSlice(set as any, get as any);
  return { state: get, slice };
}

const PROJECT_ID = 'proj-1';
const PROJECT_PATH = '/test/project';

const CONFIG = {
  id: 'durable-1',
  name: 'Durable Agent',
  color: 'blue',
  model: 'sonnet',
  worktreePath: '/test/worktree',
  branch: 'main',
  orchestrator: 'claude-code',
} as any;

describe('agentCrudSlice – loadDurableAgents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window as any).clubhouse.agent.listDurable = vi.fn().mockResolvedValue([CONFIG]);
    (window as any).clubhouse.agent.getRunningStatuses = vi.fn().mockResolvedValue([]);
    (window as any).clubhouse.agent.getBackupInfo = vi.fn().mockResolvedValue(null);
  });

  it('seeds model from the durable config for a newly loaded agent', async () => {
    const { state, slice } = createTestStore();

    await slice.loadDurableAgents(PROJECT_ID, PROJECT_PATH);

    expect(state().agents['durable-1']?.model).toBe('sonnet');
  });

  it('re-hydrates model on an agent already present in the store', async () => {
    // Regression: agents.json is the source of truth for `model`. A store entry
    // that lost the value (e.g. rebuilt on spawn) previously stayed stale for the
    // lifetime of the window, showing "Default" in settings and on the list badge.
    const { state, slice } = createTestStore({
      agents: {
        'durable-1': {
          id: 'durable-1',
          projectId: 'stale-proj',
          name: 'Durable Agent',
          kind: 'durable',
          status: 'running',
          color: 'blue',
          model: undefined,
        } as any,
      },
    });

    await slice.loadDurableAgents(PROJECT_ID, PROJECT_PATH);

    expect(state().agents['durable-1']?.model).toBe('sonnet');
    // projectId reconciliation and existing status must survive the merge
    expect(state().agents['durable-1']?.projectId).toBe(PROJECT_ID);
    expect(state().agents['durable-1']?.status).toBe('running');
  });

  it('clears a stale model when the config no longer sets one', async () => {
    (window as any).clubhouse.agent.listDurable = vi
      .fn()
      .mockResolvedValue([{ ...CONFIG, model: undefined }]);
    const { state, slice } = createTestStore({
      agents: {
        'durable-1': {
          id: 'durable-1',
          projectId: PROJECT_ID,
          name: 'Durable Agent',
          kind: 'durable',
          status: 'sleeping',
          color: 'blue',
          model: 'sonnet',
        } as any,
      },
    });

    await slice.loadDurableAgents(PROJECT_ID, PROJECT_PATH);

    expect(state().agents['durable-1']?.model).toBeUndefined();
  });
});
