import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock window.clubhouse
vi.stubGlobal('window', {
  clubhouse: {
    pty: {
      kill: vi.fn(),
    },
    agent: {
      listDurable: vi.fn().mockResolvedValue([]),
      renameDurable: vi.fn().mockResolvedValue(undefined),
      updateDurable: vi.fn().mockResolvedValue(undefined),
      deleteDurable: vi.fn().mockResolvedValue(undefined),
      deleteCommitPush: vi.fn().mockResolvedValue({ ok: true, message: '' }),
      deleteCleanupBranch: vi.fn().mockResolvedValue({ ok: true, message: '' }),
      deleteSavePatch: vi.fn().mockResolvedValue({ ok: true, message: '' }),
      deleteForce: vi.fn().mockResolvedValue({ ok: true, message: '' }),
      deleteUnregister: vi.fn().mockResolvedValue({ ok: true, message: '' }),
      reorderDurable: vi.fn().mockResolvedValue(undefined),
      getDurableConfig: vi.fn().mockResolvedValue(null),
      spawnAgent: vi.fn().mockResolvedValue(undefined),
      killAgent: vi.fn().mockResolvedValue(undefined),
      getSummaryInstruction: vi.fn().mockResolvedValue('Write summary to /tmp/clubhouse-summary-test.json'),
      getModelOptions: vi.fn().mockResolvedValue([
        { id: 'default', label: 'Default' },
        { id: 'opus', label: 'Opus' },
        { id: 'sonnet', label: 'Sonnet' },
        { id: 'haiku', label: 'Haiku' },
      ]),
    },
  },
});

import { useAgentStore } from './agentStore';
import { Agent, AgentHookEvent } from '../../shared/types';

function getState() {
  return useAgentStore.getState();
}

function seedAgent(overrides: Partial<Agent> = {}): Agent {
  const agent: Agent = {
    id: 'agent_1',
    projectId: 'proj_1',
    name: 'test-agent',
    kind: 'durable',
    status: 'running',
    color: 'indigo',
    ...overrides,
  };
  useAgentStore.setState((s) => ({
    agents: { ...s.agents, [agent.id]: agent },
  }));
  return agent;
}

describe('agentStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    useAgentStore.setState({
      agents: {},
      activeAgentId: null,
      agentSettingsOpenFor: null,
      deleteDialogAgent: null,
      agentActivity: {},
      agentSpawnedAt: {},
      agentDetailedStatus: {},
      projectActiveAgent: {},
    });
  });

  describe('updateAgentStatus', () => {
    it('sets status on existing agent', () => {
      seedAgent({ id: 'a1', status: 'running' });
      getState().updateAgentStatus('a1', 'sleeping');
      expect(getState().agents['a1'].status).toBe('sleeping');
    });

    it('no-op for unknown agent', () => {
      const before = { ...getState().agents };
      getState().updateAgentStatus('unknown', 'running');
      expect(getState().agents).toEqual(before);
    });

    it('durable sleeping <3s after spawn becomes error with message', () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      seedAgent({ id: 'a_early', kind: 'durable', status: 'running' });
      useAgentStore.setState((s) => ({
        agentSpawnedAt: { ...s.agentSpawnedAt, a_early: now },
      }));

      vi.setSystemTime(now + 2000); // 2s later
      getState().updateAgentStatus('a_early', 'sleeping');
      expect(getState().agents['a_early'].status).toBe('error');
      expect(getState().agents['a_early'].errorMessage).toContain('exited immediately');
    });

    it('durable sleeping <3s with non-zero exit includes exit code in message', () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      seedAgent({ id: 'a_code', kind: 'durable', status: 'running' });
      useAgentStore.setState((s) => ({
        agentSpawnedAt: { ...s.agentSpawnedAt, a_code: now },
      }));

      vi.setSystemTime(now + 1000);
      getState().updateAgentStatus('a_code', 'sleeping', 1);
      expect(getState().agents['a_code'].status).toBe('error');
      expect(getState().agents['a_code'].errorMessage).toContain('code 1');
    });

    it('durable sleeping <3s with explicit errorMessage preserves it', () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      seedAgent({ id: 'a_msg', kind: 'durable', status: 'running' });
      useAgentStore.setState((s) => ({
        agentSpawnedAt: { ...s.agentSpawnedAt, a_msg: now },
      }));

      vi.setSystemTime(now + 1000);
      getState().updateAgentStatus('a_msg', 'sleeping', 1, 'Custom error from binary lookup');
      expect(getState().agents['a_msg'].status).toBe('error');
      expect(getState().agents['a_msg'].errorMessage).toBe('Custom error from binary lookup');
    });

    it('durable sleeping >3s stays sleeping', () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      seedAgent({ id: 'a_late', kind: 'durable', status: 'running' });
      useAgentStore.setState((s) => ({
        agentSpawnedAt: { ...s.agentSpawnedAt, a_late: now },
      }));

      vi.setSystemTime(now + 5000); // 5s later
      getState().updateAgentStatus('a_late', 'sleeping');
      expect(getState().agents['a_late'].status).toBe('sleeping');
      expect(getState().agents['a_late'].errorMessage).toBeUndefined();
    });

    it('quick agent sleeping <3s stays sleeping (not error)', () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      seedAgent({ id: 'q_early', kind: 'quick', status: 'running' });
      useAgentStore.setState((s) => ({
        agentSpawnedAt: { ...s.agentSpawnedAt, q_early: now },
      }));

      vi.setSystemTime(now + 1000); // 1s later
      getState().updateAgentStatus('q_early', 'sleeping');
      // Quick agents don't have the early-exit-to-error logic
      expect(getState().agents['q_early'].status).toBe('sleeping');
    });

    it('clears detailedStatus when agent stops', () => {
      seedAgent({ id: 'a_stop', status: 'running' });
      useAgentStore.setState((s) => ({
        agentDetailedStatus: {
          ...s.agentDetailedStatus,
          a_stop: { state: 'working', message: 'Reading file', timestamp: Date.now() },
        },
      }));

      getState().updateAgentStatus('a_stop', 'sleeping');
      expect(getState().agentDetailedStatus['a_stop']).toBeUndefined();
    });
  });

  describe('handleHookEvent', () => {
    it('ignores stop events for non-running agents', () => {
      seedAgent({ id: 'a_sleep', status: 'sleeping' });
      getState().handleHookEvent('a_sleep', { kind: 'stop', timestamp: Date.now() });
      expect(getState().agents['a_sleep'].status).toBe('sleeping');
      expect(getState().agentDetailedStatus['a_sleep']).toBeUndefined();
    });

    it('transitions sleeping agent to running on non-stop hook event (annex wake)', () => {
      seedAgent({ id: 'a_wake', status: 'sleeping', kind: 'durable', exitCode: 0 });
      const event: AgentHookEvent = { kind: 'pre_tool', toolName: 'Read', toolVerb: 'Reading file', timestamp: Date.now() };
      getState().handleHookEvent('a_wake', event);
      expect(getState().agents['a_wake'].status).toBe('running');
      expect(getState().agents['a_wake'].exitCode).toBeUndefined();
      expect(getState().agentSpawnedAt['a_wake']).toBeDefined();
      // Should also process the hook event
      expect(getState().agentDetailedStatus['a_wake']).toBeDefined();
      expect(getState().agentDetailedStatus['a_wake'].state).toBe('working');
    });

    it('transitions error agent to running on hook event', () => {
      seedAgent({ id: 'a_err', status: 'error', kind: 'durable', errorMessage: 'launch failed' });
      getState().handleHookEvent('a_err', { kind: 'post_tool', timestamp: 100 });
      expect(getState().agents['a_err'].status).toBe('running');
      expect(getState().agents['a_err'].errorMessage).toBeUndefined();
    });

    it('pre_tool sets state:working with tool verb', () => {
      seedAgent({ id: 'a_pre', status: 'running' });
      getState().handleHookEvent('a_pre', { kind: 'pre_tool', toolName: 'Read', toolVerb: 'Reading file', timestamp: 100 });
      const status = getState().agentDetailedStatus['a_pre'];
      expect(status.state).toBe('working');
      expect(status.message).toBe('Reading file');
    });

    it('post_tool sets state:idle, "Thinking"', () => {
      seedAgent({ id: 'a_post', status: 'running' });
      getState().handleHookEvent('a_post', { kind: 'post_tool', timestamp: 100 });
      const status = getState().agentDetailedStatus['a_post'];
      expect(status.state).toBe('idle');
      expect(status.message).toBe('Thinking');
    });

    it('tool_error sets state:tool_error', () => {
      seedAgent({ id: 'a_fail', status: 'running' });
      getState().handleHookEvent('a_fail', { kind: 'tool_error', toolName: 'Bash', timestamp: 100 });
      const status = getState().agentDetailedStatus['a_fail'];
      expect(status.state).toBe('tool_error');
      expect(status.message).toContain('Bash');
    });

    it('stop sets state:idle, "Idle"', () => {
      seedAgent({ id: 'a_stop2', status: 'running' });
      getState().handleHookEvent('a_stop2', { kind: 'stop', timestamp: 100 });
      const status = getState().agentDetailedStatus['a_stop2'];
      expect(status.state).toBe('idle');
      expect(status.message).toBe('Idle');
    });

    it('notification sets state:idle with event message', () => {
      seedAgent({ id: 'a_notif', status: 'running' });
      getState().handleHookEvent('a_notif', { kind: 'notification', message: 'Awaiting a response', timestamp: 100 });
      const status = getState().agentDetailedStatus['a_notif'];
      expect(status.state).toBe('idle');
      expect(status.message).toBe('Awaiting a response');
    });

    it('permission_request sets state:needs_permission with toolName', () => {
      seedAgent({ id: 'a_perm', status: 'running' });
      getState().handleHookEvent('a_perm', { kind: 'permission_request', toolName: 'Bash', timestamp: 100 });
      const status = getState().agentDetailedStatus['a_perm'];
      expect(status.state).toBe('needs_permission');
      expect(status.message).toBe('Needs permission');
      expect(status.toolName).toBe('Bash');
    });

    it('unknown event kind causes no state change', () => {
      seedAgent({ id: 'a_unk', status: 'running' });
      getState().handleHookEvent('a_unk', { kind: 'unknown_event' as any, timestamp: 100 });
      expect(getState().agentDetailedStatus['a_unk']).toBeUndefined();
    });
  });

  describe('clearStaleStatuses', () => {
    it('clears statuses older than 30s for running agents', () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      seedAgent({ id: 'a_stale', status: 'running' });
      useAgentStore.setState((s) => ({
        agentDetailedStatus: {
          ...s.agentDetailedStatus,
          a_stale: { state: 'working', message: 'Reading file', timestamp: now - 35000 },
        },
      }));

      getState().clearStaleStatuses();
      expect(getState().agentDetailedStatus['a_stale']).toBeUndefined();
    });

    it('preserves recent statuses', () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      seedAgent({ id: 'a_fresh', status: 'running' });
      useAgentStore.setState((s) => ({
        agentDetailedStatus: {
          ...s.agentDetailedStatus,
          a_fresh: { state: 'working', message: 'Reading file', timestamp: now - 5000 },
        },
      }));

      getState().clearStaleStatuses();
      expect(getState().agentDetailedStatus['a_fresh']).toBeDefined();
    });

    it('does not clear needs_permission even if stale', () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      seedAgent({ id: 'a_perm_stale', status: 'running' });
      useAgentStore.setState((s) => ({
        agentDetailedStatus: {
          ...s.agentDetailedStatus,
          a_perm_stale: { state: 'needs_permission', message: 'Needs permission', timestamp: now - 60000 },
        },
      }));

      getState().clearStaleStatuses();
      expect(getState().agentDetailedStatus['a_perm_stale']).toBeDefined();
    });
  });

  describe('toolVerb (tested via handleHookEvent)', () => {
    it('tool verb from event is used as message', () => {
      const mappings: Record<string, string> = {
        Bash: 'Running command',
        Edit: 'Editing file',
        Write: 'Writing file',
        Read: 'Reading file',
        Glob: 'Searching files',
        Grep: 'Searching code',
        Task: 'Running task',
        WebSearch: 'Searching web',
        WebFetch: 'Fetching page',
      };

      for (const [tool, expected] of Object.entries(mappings)) {
        seedAgent({ id: `a_tool_${tool}`, status: 'running' });
        getState().handleHookEvent(`a_tool_${tool}`, { kind: 'pre_tool', toolName: tool, toolVerb: expected, timestamp: 100 });
        expect(getState().agentDetailedStatus[`a_tool_${tool}`].message).toBe(expected);
      }
    });

    it('undefined toolVerb shows "Working"', () => {
      seedAgent({ id: 'a_noname', status: 'running' });
      getState().handleHookEvent('a_noname', { kind: 'pre_tool', timestamp: 100 });
      expect(getState().agentDetailedStatus['a_noname'].message).toBe('Working');
    });
  });

  describe('updateAgent', () => {
    it('patches name in local state', async () => {
      seedAgent({ id: 'a_upd', name: 'old' });
      await getState().updateAgent('a_upd', { name: 'new' }, '/proj');
      expect(getState().agents['a_upd'].name).toBe('new');
      expect(getState().agents['a_upd'].color).toBe('indigo'); // unchanged
    });

    it('patches color in local state', async () => {
      seedAgent({ id: 'a_color', color: 'indigo' });
      await getState().updateAgent('a_color', { color: 'emerald' }, '/proj');
      expect(getState().agents['a_color'].color).toBe('emerald');
    });

    it('sets icon in local state', async () => {
      seedAgent({ id: 'a_icon' });
      await getState().updateAgent('a_icon', { icon: 'a_icon.png' }, '/proj');
      expect(getState().agents['a_icon'].icon).toBe('a_icon.png');
    });

    it('clears icon (null → undefined) in local state', async () => {
      seedAgent({ id: 'a_clear', icon: 'a_clear.png' });
      await getState().updateAgent('a_clear', { icon: null }, '/proj');
      expect(getState().agents['a_clear'].icon).toBeUndefined();
    });

    it('calls updateDurable IPC', async () => {
      seedAgent({ id: 'a_ipc' });
      await getState().updateAgent('a_ipc', { name: 'x', color: 'amber' }, '/proj');
      expect(window.clubhouse.agent.updateDurable).toHaveBeenCalledWith('/proj', 'a_ipc', { name: 'x', color: 'amber' });
    });
  });

  describe('removeAgent', () => {
    it('removes from agents map', () => {
      seedAgent({ id: 'a_rem' });
      getState().removeAgent('a_rem');
      expect(getState().agents['a_rem']).toBeUndefined();
    });

    it('clears activeAgentId if it was removed agent', () => {
      seedAgent({ id: 'a_active' });
      useAgentStore.setState({ activeAgentId: 'a_active' });
      getState().removeAgent('a_active');
      expect(getState().activeAgentId).toBeNull();
    });

    it('preserves activeAgentId if different agent', () => {
      seedAgent({ id: 'a_other' });
      seedAgent({ id: 'a_keep_active' });
      useAgentStore.setState({ activeAgentId: 'a_keep_active' });
      getState().removeAgent('a_other');
      expect(getState().activeAgentId).toBe('a_keep_active');
    });
  });

  describe('per-project active agent persistence', () => {
    it('setActiveAgent with projectId saves to projectActiveAgent', () => {
      seedAgent({ id: 'a1', projectId: 'proj_1' });
      getState().setActiveAgent('a1', 'proj_1');
      expect(getState().projectActiveAgent['proj_1']).toBe('a1');
    });

    it('setActiveAgent without projectId does not save', () => {
      seedAgent({ id: 'a1' });
      getState().setActiveAgent('a1');
      expect(getState().projectActiveAgent).toEqual({});
    });

    it('setActiveAgent(null) clears active agent for project', () => {
      useAgentStore.setState({ projectActiveAgent: { proj_1: 'a1' } });
      getState().setActiveAgent(null, 'proj_1');
      expect(getState().projectActiveAgent['proj_1']).toBeNull();
    });

    it('restoreProjectAgent restores saved agent for project', () => {
      seedAgent({ id: 'a1', projectId: 'proj_1' });
      useAgentStore.setState({ projectActiveAgent: { proj_1: 'a1' } });
      getState().restoreProjectAgent('proj_1');
      expect(getState().activeAgentId).toBe('a1');
    });

    it('restoreProjectAgent sets null if saved agent belongs to different project', () => {
      seedAgent({ id: 'a1', projectId: 'proj_2' });
      useAgentStore.setState({ projectActiveAgent: { proj_1: 'a1' }, activeAgentId: 'a1' });
      getState().restoreProjectAgent('proj_1');
      expect(getState().activeAgentId).toBeNull();
    });

    it('restoreProjectAgent sets null if no saved agent', () => {
      useAgentStore.setState({ activeAgentId: 'some_agent' });
      getState().restoreProjectAgent('proj_new');
      expect(getState().activeAgentId).toBeNull();
    });

    it('restoreProjectAgent sets null if saved agent no longer exists', () => {
      useAgentStore.setState({ projectActiveAgent: { proj_1: 'deleted_agent' }, activeAgentId: 'something' });
      getState().restoreProjectAgent('proj_1');
      expect(getState().activeAgentId).toBeNull();
    });

    it('removeAgent clears projectActiveAgent for the removed agent', () => {
      seedAgent({ id: 'a_rem', projectId: 'proj_1' });
      useAgentStore.setState({ projectActiveAgent: { proj_1: 'a_rem' }, activeAgentId: 'a_rem' });
      getState().removeAgent('a_rem');
      expect(getState().projectActiveAgent['proj_1']).toBeUndefined();
    });

    it('removeAgent preserves projectActiveAgent for other projects', () => {
      seedAgent({ id: 'a_rem', projectId: 'proj_1' });
      seedAgent({ id: 'a_keep', projectId: 'proj_2' });
      useAgentStore.setState({ projectActiveAgent: { proj_1: 'a_rem', proj_2: 'a_keep' } });
      getState().removeAgent('a_rem');
      expect(getState().projectActiveAgent['proj_2']).toBe('a_keep');
    });

    it('openAgentSettings saves to projectActiveAgent', () => {
      seedAgent({ id: 'a_settings', projectId: 'proj_1' });
      getState().openAgentSettings('a_settings');
      expect(getState().projectActiveAgent['proj_1']).toBe('a_settings');
    });

    it('different projects maintain independent active agents', () => {
      seedAgent({ id: 'a1', projectId: 'proj_1' });
      seedAgent({ id: 'a2', projectId: 'proj_2' });
      getState().setActiveAgent('a1', 'proj_1');
      getState().setActiveAgent('a2', 'proj_2');
      expect(getState().projectActiveAgent['proj_1']).toBe('a1');
      expect(getState().projectActiveAgent['proj_2']).toBe('a2');
    });
  });

  describe('spawnQuickAgent with quick agent defaults', () => {
    const mockAgent = window.clubhouse.agent as any;

    beforeEach(() => {
      mockAgent.spawnAgent.mockResolvedValue(undefined);
      mockAgent.getSummaryInstruction.mockResolvedValue('Write summary to /tmp/clubhouse-summary-test.json');
      mockAgent.getDurableConfig.mockResolvedValue(null);
    });

    it('parent with systemPrompt — included in spawnAgent systemPrompt', async () => {
      seedAgent({ id: 'parent_1', kind: 'durable', worktreePath: '/wt/parent' });
      mockAgent.getDurableConfig.mockResolvedValue({
        id: 'parent_1',
        name: 'parent',
        quickAgentDefaults: { systemPrompt: 'Be concise and focused' },
      });

      await getState().spawnQuickAgent('proj_1', '/project', 'do stuff', undefined, 'parent_1');

      const spawnCall = mockAgent.spawnAgent.mock.calls[0][0];
      expect(spawnCall.systemPrompt).toContain('Be concise and focused');
      expect(spawnCall.systemPrompt).toContain('clubhouse-summary');
    });

    it('parent with allowedTools — passes to spawnAgent', async () => {
      seedAgent({ id: 'parent_2', kind: 'durable', worktreePath: '/wt/parent' });
      mockAgent.getDurableConfig.mockResolvedValue({
        id: 'parent_2',
        name: 'parent',
        quickAgentDefaults: { allowedTools: ['Bash(npm test:*)', 'Edit'] },
      });

      await getState().spawnQuickAgent('proj_1', '/project', 'do stuff', undefined, 'parent_2');

      const spawnCall = mockAgent.spawnAgent.mock.calls[0][0];
      expect(spawnCall.allowedTools).toEqual(['Bash(npm test:*)', 'Edit']);
    });

    it('parent with defaultModel, no explicit model — uses parent model', async () => {
      seedAgent({ id: 'parent_3', kind: 'durable', worktreePath: '/wt/parent' });
      mockAgent.getDurableConfig.mockResolvedValue({
        id: 'parent_3',
        name: 'parent',
        quickAgentDefaults: { defaultModel: 'haiku' },
      });

      await getState().spawnQuickAgent('proj_1', '/project', 'do stuff', undefined, 'parent_3');

      const spawnCall = mockAgent.spawnAgent.mock.calls[0][0];
      expect(spawnCall.model).toBe('haiku');
    });

    it('explicit model overrides parent defaultModel', async () => {
      seedAgent({ id: 'parent_4', kind: 'durable', worktreePath: '/wt/parent' });
      mockAgent.getDurableConfig.mockResolvedValue({
        id: 'parent_4',
        name: 'parent',
        quickAgentDefaults: { defaultModel: 'haiku' },
      });

      await getState().spawnQuickAgent('proj_1', '/project', 'do stuff', 'opus', 'parent_4');

      const spawnCall = mockAgent.spawnAgent.mock.calls[0][0];
      expect(spawnCall.model).toBe('opus');
    });

    it('orphan quick agent — no getDurableConfig call', async () => {
      await getState().spawnQuickAgent('proj_1', '/project', 'do stuff');

      expect(mockAgent.getDurableConfig).not.toHaveBeenCalled();
    });

    it('calls spawnAgent with correct params', async () => {
      await getState().spawnQuickAgent('proj_1', '/project', 'do stuff', 'sonnet');

      const spawnCall = mockAgent.spawnAgent.mock.calls[0][0];
      expect(spawnCall.projectPath).toBe('/project');
      expect(spawnCall.cwd).toBe('/project');
      expect(spawnCall.kind).toBe('quick');
      expect(spawnCall.model).toBe('sonnet');
      expect(spawnCall.mission).toBe('do stuff');
    });
  });

  describe('reorderAgents', () => {
    it('calls reorderDurable IPC with correct args', async () => {
      await getState().reorderAgents('/project', ['id_b', 'id_a', 'id_c']);
      expect(window.clubhouse.agent.reorderDurable).toHaveBeenCalledWith('/project', ['id_b', 'id_a', 'id_c']);
    });
  });

  describe('loadDurableAgents', () => {
    it('loads model from durable config', async () => {
      const mockAgent = window.clubhouse.agent as any;
      mockAgent.listDurable.mockResolvedValue([
        { id: 'durable_m1', name: 'model-agent', color: 'indigo', model: 'opus', createdAt: '2024-01-01' },
      ]);

      await getState().loadDurableAgents('proj_1', '/project');
      expect(getState().agents['durable_m1'].model).toBe('opus');
    });

    it('loads agent without model (undefined)', async () => {
      const mockAgent = window.clubhouse.agent as any;
      mockAgent.listDurable.mockResolvedValue([
        { id: 'durable_nomodel', name: 'no-model', color: 'emerald', createdAt: '2024-01-01' },
      ]);

      await getState().loadDurableAgents('proj_1', '/project');
      expect(getState().agents['durable_nomodel'].model).toBeUndefined();
    });

    it('updates projectId when same agent is loaded under a different project', async () => {
      const mockAgent = window.clubhouse.agent as any;
      mockAgent.listDurable.mockResolvedValue([
        { id: 'durable_dup', name: 'dup-agent', color: 'indigo', createdAt: '2024-01-01' },
      ]);

      // First load under project A
      await getState().loadDurableAgents('proj_A', '/shared-path');
      expect(getState().agents['durable_dup'].projectId).toBe('proj_A');

      // Second load under project B (same path, different store ID)
      await getState().loadDurableAgents('proj_B', '/shared-path');
      expect(getState().agents['durable_dup'].projectId).toBe('proj_B');
    });
  });

  describe('openAgentSettings', () => {
    it('sets agentSettingsOpenFor and activeAgentId', () => {
      seedAgent({ id: 'settings_agent', projectId: 'proj_1' });
      getState().openAgentSettings('settings_agent');
      expect(getState().agentSettingsOpenFor).toBe('settings_agent');
      expect(getState().activeAgentId).toBe('settings_agent');
    });

    it('works for agents without worktreePath', () => {
      seedAgent({ id: 'no_wt_agent', projectId: 'proj_1', worktreePath: undefined });
      getState().openAgentSettings('no_wt_agent');
      expect(getState().agentSettingsOpenFor).toBe('no_wt_agent');
      expect(getState().activeAgentId).toBe('no_wt_agent');
    });
  });
});
