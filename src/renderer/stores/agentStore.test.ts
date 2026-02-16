import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock window.clubhouse
vi.stubGlobal('window', {
  clubhouse: {
    pty: {
      spawn: vi.fn(),
      kill: vi.fn(),
    },
    agent: {
      listDurable: vi.fn().mockResolvedValue([]),
      setupHooks: vi.fn().mockResolvedValue(undefined),
      renameDurable: vi.fn().mockResolvedValue(undefined),
      deleteDurable: vi.fn().mockResolvedValue(undefined),
      deleteCommitPush: vi.fn().mockResolvedValue({ ok: true, message: '' }),
      deleteCleanupBranch: vi.fn().mockResolvedValue({ ok: true, message: '' }),
      deleteSavePatch: vi.fn().mockResolvedValue({ ok: true, message: '' }),
      deleteForce: vi.fn().mockResolvedValue({ ok: true, message: '' }),
      deleteUnregister: vi.fn().mockResolvedValue({ ok: true, message: '' }),
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
    localOnly: false,
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

    it('durable sleeping <3s after spawn becomes error', () => {
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
    it('ignores non-running agents', () => {
      seedAgent({ id: 'a_sleep', status: 'sleeping' });
      const event: AgentHookEvent = { eventName: 'PreToolUse', toolName: 'Read', timestamp: Date.now() };
      getState().handleHookEvent('a_sleep', event);
      expect(getState().agentDetailedStatus['a_sleep']).toBeUndefined();
    });

    it('PreToolUse sets state:working with tool verb', () => {
      seedAgent({ id: 'a_pre', status: 'running' });
      getState().handleHookEvent('a_pre', { eventName: 'PreToolUse', toolName: 'Read', timestamp: 100 });
      const status = getState().agentDetailedStatus['a_pre'];
      expect(status.state).toBe('working');
      expect(status.message).toBe('Reading file');
    });

    it('PostToolUse sets state:idle, "Thinking"', () => {
      seedAgent({ id: 'a_post', status: 'running' });
      getState().handleHookEvent('a_post', { eventName: 'PostToolUse', timestamp: 100 });
      const status = getState().agentDetailedStatus['a_post'];
      expect(status.state).toBe('idle');
      expect(status.message).toBe('Thinking');
    });

    it('PostToolUseFailure sets state:tool_error', () => {
      seedAgent({ id: 'a_fail', status: 'running' });
      getState().handleHookEvent('a_fail', { eventName: 'PostToolUseFailure', toolName: 'Bash', timestamp: 100 });
      const status = getState().agentDetailedStatus['a_fail'];
      expect(status.state).toBe('tool_error');
      expect(status.message).toContain('Bash');
    });

    it('Stop sets state:idle, "Idle"', () => {
      seedAgent({ id: 'a_stop2', status: 'running' });
      getState().handleHookEvent('a_stop2', { eventName: 'Stop', timestamp: 100 });
      const status = getState().agentDetailedStatus['a_stop2'];
      expect(status.state).toBe('idle');
      expect(status.message).toBe('Idle');
    });

    it('Notification sets state:needs_permission', () => {
      seedAgent({ id: 'a_notif', status: 'running' });
      getState().handleHookEvent('a_notif', { eventName: 'Notification', timestamp: 100 });
      const status = getState().agentDetailedStatus['a_notif'];
      expect(status.state).toBe('needs_permission');
      expect(status.message).toBe('Needs permission');
    });

    it('unknown event causes no state change', () => {
      seedAgent({ id: 'a_unk', status: 'running' });
      getState().handleHookEvent('a_unk', { eventName: 'SomeUnknownEvent', timestamp: 100 });
      expect(getState().agentDetailedStatus['a_unk']).toBeUndefined();
    });
  });

  describe('toolVerb (tested via handleHookEvent)', () => {
    it('known tools map correctly', () => {
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
        getState().handleHookEvent(`a_tool_${tool}`, { eventName: 'PreToolUse', toolName: tool, timestamp: 100 });
        expect(getState().agentDetailedStatus[`a_tool_${tool}`].message).toBe(expected);
      }
    });

    it('unknown tool shows "Using {name}"', () => {
      seedAgent({ id: 'a_custom', status: 'running' });
      getState().handleHookEvent('a_custom', { eventName: 'PreToolUse', toolName: 'CustomTool', timestamp: 100 });
      expect(getState().agentDetailedStatus['a_custom'].message).toBe('Using CustomTool');
    });

    it('undefined tool shows "Working"', () => {
      seedAgent({ id: 'a_noname', status: 'running' });
      getState().handleHookEvent('a_noname', { eventName: 'PreToolUse', timestamp: 100 });
      expect(getState().agentDetailedStatus['a_noname'].message).toBe('Working');
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
});
