import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the agent store
const mockSetResumeStatus = vi.fn();
const mockAgents: Record<string, { status: string }> = {};
const mockSetState = vi.fn();

vi.mock('../stores/agentStore', () => {
  // References to outer const are safe here because vi.mock hoists the
  // factory but the const declarations are also hoisted (as undefined)
  // and then assigned before first use in tests.
  return {
    useAgentStore: {
      getState: () => ({
        agents: mockAgents,
        setResumeStatus: mockSetResumeStatus,
        clearResumingAgents: vi.fn(),
      }),
      setState: (...args: unknown[]) => mockSetState(...args),
      subscribe: vi.fn().mockReturnValue(vi.fn()),
    },
  };
});

vi.mock('../stores/projectStore', () => ({
  useProjectStore: {
    getState: () => ({
      projects: [{ id: 'proj-1', path: '/projects/test', name: 'Test' }],
    }),
  },
}));

// Mock window.clubhouse
const mockSpawnAgent = vi.fn().mockResolvedValue(undefined);
Object.defineProperty(globalThis, 'window', {
  value: {
    clubhouse: {
      agent: {
        spawnAgent: mockSpawnAgent,
      },
    },
  },
  writable: true,
});

import { processResumeQueue } from './resume-queue';
import { useAgentStore } from '../stores/agentStore';
import type { RestartSessionState, RestartSessionEntry } from '../../shared/types';

// Helper to build a minimal RestartSessionEntry
function makeEntry(overrides: Partial<RestartSessionEntry> = {}): RestartSessionEntry {
  return {
    agentId: 'test-agent',
    agentName: 'Test Agent',
    projectPath: '/projects/test',
    orchestrator: 'claude-code',
    sessionId: null,
    resumeStrategy: 'auto',
    kind: 'durable',
    ...overrides,
  };
}

function makeState(sessions: RestartSessionEntry[]): RestartSessionState {
  return {
    version: 1,
    capturedAt: new Date().toISOString(),
    appVersion: '0.30.0',
    sessions,
  };
}

describe('resume-queue', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Clear mockAgents between tests
    for (const key of Object.keys(mockAgents)) {
      delete mockAgents[key];
    }

    // Default subscribe: immediately resolve (agent appears as running)
    vi.mocked(useAgentStore.subscribe).mockImplementation((callback) => {
      mockAgents['test-agent'] = { status: 'running' };
      setTimeout(() => (callback as () => void)(), 0);
      return vi.fn();
    });
  });

  describe('processResumeQueue', () => {
    it('sets initial status to pending for auto-resume agents', async () => {
      const state = makeState([makeEntry({ agentId: 'agent-1', resumeStrategy: 'auto' })]);

      vi.mocked(useAgentStore.subscribe).mockImplementation((callback) => {
        mockAgents['agent-1'] = { status: 'running' };
        setTimeout(() => (callback as () => void)(), 0);
        return vi.fn();
      });

      await processResumeQueue(state);

      // First call should set to 'pending', subsequent ones by resumeAgent set 'resuming' then 'resumed'
      expect(mockSetResumeStatus).toHaveBeenCalledWith('agent-1', 'pending');
    });

    it('sets initial status to manual for manual agents', async () => {
      const state = makeState([makeEntry({ agentId: 'agent-manual', resumeStrategy: 'manual' })]);

      await processResumeQueue(state);

      expect(mockSetResumeStatus).toHaveBeenCalledWith('agent-manual', 'manual');
    });

    it('calls spawnAgent with correct params for auto-resume agents (resume: true, sessionId)', async () => {
      const entry = makeEntry({
        agentId: 'spawn-agent',
        sessionId: 'session-abc',
        projectPath: '/projects/spawn',
        orchestrator: 'claude-code',
        kind: 'durable',
        model: 'claude-opus-4',
        mission: 'Fix the bug',
        resumeStrategy: 'auto',
      });

      vi.mocked(useAgentStore.subscribe).mockImplementation((callback) => {
        mockAgents['spawn-agent'] = { status: 'running' };
        setTimeout(() => (callback as () => void)(), 0);
        return vi.fn();
      });

      await processResumeQueue(makeState([entry]));

      expect(mockSpawnAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'spawn-agent',
          projectPath: '/projects/spawn',
          cwd: '/projects/spawn',
          kind: 'durable',
          resume: true,
          sessionId: 'session-abc',
          orchestrator: 'claude-code',
          model: 'claude-opus-4',
          mission: 'Fix the bug',
        }),
      );
    });

    it('skips spawnAgent for manual agents', async () => {
      const state = makeState([makeEntry({ agentId: 'manual-skip', resumeStrategy: 'manual' })]);

      await processResumeQueue(state);

      expect(mockSpawnAgent).not.toHaveBeenCalled();
    });

    it('passes worktreePath as cwd when available', async () => {
      const entry = makeEntry({
        agentId: 'worktree-agent',
        projectPath: '/projects/main',
        worktreePath: '/projects/worktree-branch',
        resumeStrategy: 'auto',
      });

      vi.mocked(useAgentStore.subscribe).mockImplementation((callback) => {
        mockAgents['worktree-agent'] = { status: 'running' };
        setTimeout(() => (callback as () => void)(), 0);
        return vi.fn();
      });

      await processResumeQueue(makeState([entry]));

      expect(mockSpawnAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: '/projects/worktree-branch',
          projectPath: '/projects/main',
        }),
      );
    });

    it('falls back to projectPath as cwd when worktreePath is absent', async () => {
      const entry = makeEntry({
        agentId: 'no-worktree-agent',
        projectPath: '/projects/main',
        worktreePath: undefined,
        resumeStrategy: 'auto',
      });

      vi.mocked(useAgentStore.subscribe).mockImplementation((callback) => {
        mockAgents['no-worktree-agent'] = { status: 'running' };
        setTimeout(() => (callback as () => void)(), 0);
        return vi.fn();
      });

      await processResumeQueue(makeState([entry]));

      expect(mockSpawnAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: '/projects/main',
        }),
      );
    });
  });

  describe('resumeAgent fallback', () => {
    it('retries without sessionId when spawnAgent fails and entry has a sessionId', async () => {
      const entry = makeEntry({
        agentId: 'fallback-agent',
        sessionId: 'session-xyz',
        resumeStrategy: 'auto',
      });

      // First call fails, second succeeds
      mockSpawnAgent
        .mockRejectedValueOnce(new Error('session not found'))
        .mockResolvedValueOnce(undefined);

      vi.mocked(useAgentStore.subscribe).mockImplementation((callback) => {
        mockAgents['fallback-agent'] = { status: 'running' };
        setTimeout(() => (callback as () => void)(), 0);
        return vi.fn();
      });

      await processResumeQueue(makeState([entry]));

      expect(mockSpawnAgent).toHaveBeenCalledTimes(2);

      // Second call must omit sessionId (--continue fallback)
      expect(mockSpawnAgent).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          agentId: 'fallback-agent',
          resume: true,
          sessionId: undefined,
        }),
      );

      expect(mockSetResumeStatus).toHaveBeenCalledWith('fallback-agent', 'resumed');
    });

    it('sets status to failed when both spawnAgent attempts fail', async () => {
      const entry = makeEntry({
        agentId: 'double-fail-agent',
        sessionId: 'session-bad',
        resumeStrategy: 'auto',
      });

      mockSpawnAgent
        .mockRejectedValueOnce(new Error('first failure'))
        .mockRejectedValueOnce(new Error('second failure'));

      await processResumeQueue(makeState([entry]));

      expect(mockSpawnAgent).toHaveBeenCalledTimes(2);
      expect(mockSetResumeStatus).toHaveBeenCalledWith('double-fail-agent', 'failed');
    });

    it('sets status to failed when spawnAgent fails and there is no sessionId to fall back from', async () => {
      const entry = makeEntry({
        agentId: 'no-session-fail-agent',
        sessionId: null,
        resumeStrategy: 'auto',
      });

      mockSpawnAgent.mockRejectedValueOnce(new Error('spawn error'));

      await processResumeQueue(makeState([entry]));

      // No fallback attempt since there was no sessionId
      expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
      expect(mockSetResumeStatus).toHaveBeenCalledWith('no-session-fail-agent', 'failed');
    });
  });

  describe('sequential per-workspace', () => {
    it('resumes agents in the same projectPath sequentially', async () => {
      const callOrder: string[] = [];

      const entries = [
        makeEntry({ agentId: 'seq-agent-1', projectPath: '/projects/same' }),
        makeEntry({ agentId: 'seq-agent-2', projectPath: '/projects/same' }),
      ];

      mockSpawnAgent.mockImplementation(({ agentId }: { agentId: string }) => {
        callOrder.push(agentId);
        return Promise.resolve();
      });

      vi.mocked(useAgentStore.subscribe).mockImplementation((callback) => {
        const id = callOrder[callOrder.length - 1];
        if (id) mockAgents[id] = { status: 'running' };
        setTimeout(() => (callback as () => void)(), 0);
        return vi.fn();
      });

      await processResumeQueue(makeState(entries));

      // Both agents must have been spawned
      expect(callOrder).toContain('seq-agent-1');
      expect(callOrder).toContain('seq-agent-2');

      // seq-agent-1 must appear before seq-agent-2 (sequential within workspace)
      expect(callOrder.indexOf('seq-agent-1')).toBeLessThan(callOrder.indexOf('seq-agent-2'));
    });
  });

  describe('waitForAgentRunning (timeout handling)', () => {
    it('resolves and marks agent resumed when store subscription fires with running status', async () => {
      const entry = makeEntry({ agentId: 'subscribe-agent', resumeStrategy: 'auto' });

      vi.mocked(useAgentStore.subscribe).mockImplementation((callback) => {
        mockAgents['subscribe-agent'] = { status: 'running' };
        setTimeout(() => (callback as () => void)(), 0);
        return vi.fn();
      });

      await processResumeQueue(makeState([entry]));

      expect(mockSetResumeStatus).toHaveBeenCalledWith('subscribe-agent', 'resumed');
    });

    it('does not set timed_out when agent becomes running before timeout fires', async () => {
      const entry = makeEntry({ agentId: 'fast-agent', resumeStrategy: 'auto' });

      vi.mocked(useAgentStore.subscribe).mockImplementation((callback) => {
        mockAgents['fast-agent'] = { status: 'running' };
        setTimeout(() => (callback as () => void)(), 0);
        return vi.fn();
      });

      await processResumeQueue(makeState([entry]));

      const statuses = mockSetResumeStatus.mock.calls.map(([, status]) => status);
      expect(statuses).not.toContain('timed_out');
      expect(statuses).toContain('resumed');
    });
  });
});
