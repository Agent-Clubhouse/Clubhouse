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

  it('carries the parent link and a failed creation onto the agent (#2231)', async () => {
    (window as any).clubhouse.agent.listDurable = vi.fn().mockResolvedValue([
      { ...CONFIG, parentAgentId: 'lead' },
      { ...CONFIG, id: 'durable-2', parentAgentId: 'lead', creation: { state: 'failed', startedAt: '2026-10-18T00:00:00Z', reason: 'The branch already exists' } },
      { ...CONFIG, id: 'durable-3', creation: { state: 'creating', startedAt: '2026-10-18T00:00:00Z' } },
    ]);
    const { state, slice } = createTestStore({
      agents: { 'durable-1': { id: 'durable-1', projectId: PROJECT_ID, name: 'Durable Agent', kind: 'durable', status: 'sleeping', color: 'blue' } as any },
    });

    await slice.loadDurableAgents(PROJECT_ID, PROJECT_PATH);

    expect(state().agents['durable-1']?.parentAgentId).toBe('lead');
    expect(state().agents['durable-2']).toMatchObject({ parentAgentId: 'lead', status: 'error', creationFailed: true, errorMessage: 'The branch already exists' });
    expect(state().agents['durable-3']).toMatchObject({ status: 'creating' });
    expect(state().agents['durable-3']?.creationFailed).toBeFalsy();
  });
});

describe('agentCrudSlice – backup recovery', () => {
  const RESTORED = { id: 'durable-2', name: 'Restored Agent', color: 'red' } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    (window as any).clubhouse.agent.getRunningStatuses = vi.fn().mockResolvedValue([]);
  });

  it('records the detecting project on pendingRecovery', async () => {
    (window as any).clubhouse.agent.listDurable = vi.fn().mockResolvedValue([CONFIG]);
    (window as any).clubhouse.agent.getBackupInfo = vi.fn().mockResolvedValue({
      backupAgents: [CONFIG, RESTORED],
      currentCount: 1,
    });
    const { state, slice } = createTestStore();

    await slice.loadDurableAgents(PROJECT_ID, PROJECT_PATH);

    expect(state().pendingRecovery).toMatchObject({ projectId: PROJECT_ID, projectPath: PROJECT_PATH });
  });

  it('assigns restored agents to the restoring project, not an arbitrary loaded one', async () => {
    // Regression: restored agents previously took the projectId of whichever
    // agent happened to be first in the store — usually another project.
    (window as any).clubhouse.agent.restoreFromBackup = vi.fn().mockResolvedValue({ restoredCount: 1, agents: [] });
    (window as any).clubhouse.agent.listDurable = vi.fn().mockResolvedValue([RESTORED]);
    const { state, slice } = createTestStore({
      agents: {
        'other-agent': { id: 'other-agent', projectId: 'other-proj', name: 'Other', kind: 'durable', status: 'sleeping', color: 'green' },
      } as any,
    });

    await slice.restoreFromBackup(PROJECT_ID, PROJECT_PATH);

    expect(state().agents['durable-2']?.projectId).toBe(PROJECT_ID);
    expect(state().agents['other-agent']?.projectId).toBe('other-proj');
  });
});
