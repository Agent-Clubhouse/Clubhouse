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
        loadAgentIcon: mockLoadAgentIcon,
      }),
      setState: (...args: unknown[]) => mockSetState(...args),
      subscribe: vi.fn().mockReturnValue(vi.fn()),
    },
  };
});

vi.mock('../stores/projectStore', () => ({
  useProjectStore: {
    getState: () => ({
      projects: [
        { id: 'proj-1', path: '/projects/test', name: 'Test' },
        { id: 'proj-win', path: 'C:\\Projects\\Win', name: 'Win' },
      ],
    }),
  },
}));

// Mock window.clubhouse
const mockSpawnAgent = vi.fn().mockResolvedValue(undefined);
const mockGetDurableConfig = vi.fn().mockResolvedValue(null);
const mockLoadAgentIcon = vi.fn().mockResolvedValue(undefined);
const mockPtyKill = vi.fn();
Object.defineProperty(globalThis, 'window', {
  value: {
    clubhouse: {
      agent: {
        spawnAgent: mockSpawnAgent,
        getDurableConfig: mockGetDurableConfig,
      },
      pty: {
        kill: mockPtyKill,
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
        }),
      );
      // The resumed session already has its mission; sending it again replays it (#2074)
      expect(mockSpawnAgent.mock.calls[0][0]).not.toHaveProperty('mission');
    });

    it('never sends the original mission with resume: true, including on the --continue fallback (#2074)', async () => {
      const entry = makeEntry({
        agentId: 'replay-agent',
        sessionId: 'session-1',
        kind: 'durable',
        mission: 'Refactor the auth module',
        resumeStrategy: 'auto',
      });
      mockSpawnAgent
        .mockRejectedValueOnce(new Error('session not found'))
        .mockResolvedValueOnce(undefined);
      vi.mocked(useAgentStore.subscribe).mockImplementation((callback) => {
        mockAgents['replay-agent'] = { status: 'running' };
        setTimeout(() => (callback as () => void)(), 0);
        return vi.fn();
      });

      await processResumeQueue(makeState([entry]));

      expect(mockSpawnAgent).toHaveBeenCalledTimes(2);
      for (const [params] of mockSpawnAgent.mock.calls) {
        expect(params).toMatchObject({ resume: true });
        expect(params.mission).toBeUndefined();
      }
    });

    describe('an entry with no session id (#2074)', () => {
      function settle(id: string) {
        vi.mocked(useAgentStore.subscribe).mockImplementation((callback) => {
          mockAgents[id] = { status: 'running' };
          setTimeout(() => (callback as () => void)(), 0);
          return vi.fn();
        });
      }

      it('an agent that never started a session is spawned fresh WITH its mission', async () => {
        settle('never-started');
        const entry = makeEntry({ agentId: 'never-started', sessionId: null, sessionStarted: false, mission: 'Write the spec', resumeStrategy: 'auto' });
        await processResumeQueue(makeState([entry]));
        expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
        expect(mockSpawnAgent.mock.calls[0][0]).toMatchObject({ agentId: 'never-started', resume: false, mission: 'Write the spec' });
        expect(mockSpawnAgent.mock.calls[0][0].sessionId).toBeUndefined();
      });

      it('an agent whose id capture failed resumes the most recent session, without the mission', async () => {
        settle('lost-id');
        const entry = makeEntry({ agentId: 'lost-id', sessionId: null, mission: 'Write the spec', resumeStrategy: 'auto' });
        await processResumeQueue(makeState([entry]));
        expect(mockSpawnAgent.mock.calls[0][0]).toMatchObject({ agentId: 'lost-id', resume: true });
        expect(mockSpawnAgent.mock.calls[0][0].sessionId).toBeUndefined();
        expect(mockSpawnAgent.mock.calls[0][0].mission).toBeUndefined();
      });

      it('an entry from an older version (no sessionStarted) also resumes without the mission', async () => {
        settle('old-entry');
        const entry = makeEntry({ agentId: 'old-entry', sessionId: null, mission: 'Old task', resumeStrategy: 'auto' });
        delete (entry as { sessionStarted?: boolean }).sessionStarted;
        await processResumeQueue(makeState([entry]));
        expect(mockSpawnAgent.mock.calls[0][0]).toMatchObject({ resume: true });
        expect(mockSpawnAgent.mock.calls[0][0].mission).toBeUndefined();
      });
    });

    it('still shows the mission on the resumed agent', async () => {
      const entry = makeEntry({ agentId: 'shown-agent', kind: 'quick', mission: 'Write the spec', resumeStrategy: 'auto' });
      vi.mocked(useAgentStore.subscribe).mockImplementation((callback) => {
        mockAgents['shown-agent'] = { status: 'running' };
        setTimeout(() => (callback as () => void)(), 0);
        return vi.fn();
      });
      await processResumeQueue(makeState([entry]));
      const setState = mockSetState.mock.calls.map(([u]) => (typeof u === 'function' ? u({ agents: {}, agentSpawnedAt: {} } as never) : u));
      expect(setState.some((s) => (s as { agents?: Record<string, { mission?: string }> }).agents?.['shown-agent']?.mission === 'Write the spec')).toBe(true);
      expect(mockSpawnAgent.mock.calls[0][0].mission).toBeUndefined();
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

      // Must kill existing process before retrying to prevent orphaned agents
      expect(mockPtyKill).toHaveBeenCalledWith('fallback-agent');
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

  describe('the store record a resume writes (#2410)', () => {
    beforeEach(() => mockGetDurableConfig.mockResolvedValue(null));

    // Run the resume and return the agent record it wrote, applied to a store
    // that already holds `existing` (as after loadDurableAgents) or is empty.
    async function resumedRecord(entry: RestartSessionEntry, existing?: Record<string, unknown>) {
      vi.mocked(useAgentStore.subscribe).mockImplementation((callback) => {
        mockAgents[entry.agentId] = { status: 'running' };
        setTimeout(() => (callback as () => void)(), 0);
        return vi.fn();
      });
      if (existing) mockAgents[entry.agentId] = existing as { status: string };
      await processResumeQueue(makeState([entry]));
      for (const [updater] of mockSetState.mock.calls) {
        if (typeof updater !== 'function') continue;
        const next = updater({ agents: {}, agentSpawnedAt: {} });
        if (next?.agents?.[entry.agentId]?.resuming) return next.agents[entry.agentId];
      }
      throw new Error('resume wrote no agent record');
    }

    it('keeps the parent link of a helper already in the store', async () => {
      const record = await resumedRecord(
        makeEntry({ agentId: 'helper' }),
        { id: 'helper', projectId: 'proj-1', kind: 'durable', status: 'sleeping', parentAgentId: 'lead' },
      );
      expect(record.parentAgentId).toBe('lead');
    });

    it('takes the parent link from the saved config when the store has no record yet', async () => {
      mockGetDurableConfig.mockResolvedValue({ id: 'helper', name: 'helper', color: 'red', parentAgentId: 'lead' });
      const record = await resumedRecord(makeEntry({ agentId: 'helper' }));
      expect(record.parentAgentId).toBe('lead');
    });

    it('drops a parent link the saved config no longer has', async () => {
      mockGetDurableConfig.mockResolvedValue({ id: 'helper', name: 'helper', color: 'red' });
      const record = await resumedRecord(
        makeEntry({ agentId: 'helper' }),
        { id: 'helper', projectId: 'proj-1', kind: 'durable', status: 'sleeping', parentAgentId: 'lead' },
      );
      expect(record.parentAgentId).toBeUndefined();
    });

    it('keeps other fields the resume does not know, and drops stale sleep and error state', async () => {
      const record = await resumedRecord(
        makeEntry({ agentId: 'helper' }),
        {
          id: 'helper', projectId: 'proj-1', kind: 'durable', status: 'sleeping',
          executionMode: 'headless', pluginOwner: 'plug', color: 'green', model: 'claude-opus-4',
          lastSleep: { reason: 'user', at: '2026-01-01T00:00:00.000Z' }, exitCode: 1, errorMessage: 'boom',
        },
      );
      expect(record).toMatchObject({ executionMode: 'headless', pluginOwner: 'plug', color: 'green', model: 'claude-opus-4', status: 'running' });
      expect(record.lastSleep).toBeUndefined();
      expect(record.exitCode).toBeUndefined();
      expect(record.errorMessage).toBeUndefined();
    });

    it('finds the project when the path differs only in trailing separator', async () => {
      const record = await resumedRecord(makeEntry({ agentId: 'slash', projectPath: '/projects/test/' }));
      expect(record.projectId).toBe('proj-1');
    });

    it('finds the project when a Windows path differs in case and slash style', async () => {
      const original = window.clubhouse;
      (window as any).clubhouse = { ...original, platform: 'win32' };
      try {
        const record = await resumedRecord(makeEntry({ agentId: 'win', projectPath: 'c:/projects/win' }));
        expect(record.projectId).toBe('proj-win');
      } finally {
        (window as any).clubhouse = original;
      }
    });

    it('does not fold case on other platforms', async () => {
      const record = await resumedRecord(makeEntry({ agentId: 'posix', projectPath: '/Projects/Test' }));
      expect(record.projectId).toBe('/Projects/Test');
    });
  });

  describe('agent settings restoration from durable config', () => {
    const durableConfig = {
      id: 'settings-agent',
      name: 'Settings Agent',
      color: 'purple',
      icon: 'settings-agent-12345.png',
      branch: 'feature/fix-bug',
      worktreePath: '/projects/worktree',
      createdAt: '2025-01-01T00:00:00.000Z',
      model: 'claude-opus-4',
      freeAgentMode: true,
      // Legacy flag from before structured mode was removed; must be ignored.
      structuredMode: true,
      mcpIds: ['mcp-1', 'mcp-2'],
      orchestrator: 'claude-code',
    };

    beforeEach(() => {
      mockGetDurableConfig.mockResolvedValue(durableConfig);
    });

    it('restores color from durable config instead of hardcoding gray', async () => {
      const entry = makeEntry({ agentId: 'settings-agent', resumeStrategy: 'auto' });

      vi.mocked(useAgentStore.subscribe).mockImplementation((callback) => {
        mockAgents['settings-agent'] = { status: 'running' };
        setTimeout(() => (callback as () => void)(), 0);
        return vi.fn();
      });

      await processResumeQueue(makeState([entry]));

      expect(mockGetDurableConfig).toHaveBeenCalledWith('/projects/test', 'settings-agent');

      // Verify the Agent object written to the store has the correct color
      const setStateCalls = mockSetState.mock.calls;
      const agentSetCall = setStateCalls.find((call) => {
        if (typeof call[0] === 'function') {
          const result = call[0]({ agents: {}, agentSpawnedAt: {} });
          return result?.agents?.['settings-agent']?.color === 'purple';
        }
        return false;
      });
      expect(agentSetCall).toBeDefined();
    });

    it('restores icon from durable config and calls loadAgentIcon', async () => {
      const entry = makeEntry({ agentId: 'settings-agent', resumeStrategy: 'auto' });

      vi.mocked(useAgentStore.subscribe).mockImplementation((callback) => {
        mockAgents['settings-agent'] = { status: 'running' };
        setTimeout(() => (callback as () => void)(), 0);
        return vi.fn();
      });

      await processResumeQueue(makeState([entry]));

      // Verify Agent has icon set
      const setStateCalls = mockSetState.mock.calls;
      const agentSetCall = setStateCalls.find((call) => {
        if (typeof call[0] === 'function') {
          const result = call[0]({ agents: {}, agentSpawnedAt: {} });
          return result?.agents?.['settings-agent']?.icon === 'settings-agent-12345.png';
        }
        return false;
      });
      expect(agentSetCall).toBeDefined();

      // loadAgentIcon must be called to populate the icon cache
      expect(mockLoadAgentIcon).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'settings-agent', icon: 'settings-agent-12345.png' }),
      );
    });

    it('does not call loadAgentIcon when config has no icon', async () => {
      mockGetDurableConfig.mockResolvedValue({ ...durableConfig, icon: undefined });
      const entry = makeEntry({ agentId: 'settings-agent', resumeStrategy: 'auto' });

      vi.mocked(useAgentStore.subscribe).mockImplementation((callback) => {
        mockAgents['settings-agent'] = { status: 'running' };
        setTimeout(() => (callback as () => void)(), 0);
        return vi.fn();
      });

      await processResumeQueue(makeState([entry]));

      expect(mockLoadAgentIcon).not.toHaveBeenCalled();
    });

    it('restores freeAgentMode from durable config', async () => {
      const entry = makeEntry({ agentId: 'settings-agent', resumeStrategy: 'auto' });

      vi.mocked(useAgentStore.subscribe).mockImplementation((callback) => {
        mockAgents['settings-agent'] = { status: 'running' };
        setTimeout(() => (callback as () => void)(), 0);
        return vi.fn();
      });

      await processResumeQueue(makeState([entry]));

      // Verify Agent store has freeAgentMode
      const setStateCalls = mockSetState.mock.calls;
      const agentSetCall = setStateCalls.find((call) => {
        if (typeof call[0] === 'function') {
          const result = call[0]({ agents: {}, agentSpawnedAt: {} });
          return result?.agents?.['settings-agent']?.freeAgentMode === true;
        }
        return false;
      });
      expect(agentSetCall).toBeDefined();

      // Also verify freeAgentMode is passed to spawnAgent
      expect(mockSpawnAgent).toHaveBeenCalledWith(
        expect.objectContaining({ freeAgentMode: true }),
      );
    });

    it('prefers entry.freeAgentMode over durable config', async () => {
      // Entry says freeAgentMode is false, config says true — entry wins
      const entry = makeEntry({
        agentId: 'settings-agent',
        resumeStrategy: 'auto',
        freeAgentMode: false,
      } as Partial<RestartSessionEntry>);

      vi.mocked(useAgentStore.subscribe).mockImplementation((callback) => {
        mockAgents['settings-agent'] = { status: 'running' };
        setTimeout(() => (callback as () => void)(), 0);
        return vi.fn();
      });

      await processResumeQueue(makeState([entry]));

      expect(mockSpawnAgent).toHaveBeenCalledWith(
        expect.objectContaining({ freeAgentMode: false }),
      );
    });

    it('does not restore a legacy structuredMode from durable config', async () => {
      const entry = makeEntry({ agentId: 'settings-agent', resumeStrategy: 'auto' });

      vi.mocked(useAgentStore.subscribe).mockImplementation((callback) => {
        mockAgents['settings-agent'] = { status: 'running' };
        setTimeout(() => (callback as () => void)(), 0);
        return vi.fn();
      });

      await processResumeQueue(makeState([entry]));

      // The Agent written to the store does not carry structuredMode
      const setStateCalls = mockSetState.mock.calls;
      const agentSetCall = setStateCalls.find((call) => {
        if (typeof call[0] === 'function') {
          const result = call[0]({ agents: {}, agentSpawnedAt: {} });
          return !!result?.agents?.['settings-agent'];
        }
        return false;
      });
      expect(agentSetCall).toBeDefined();
      const agent = (agentSetCall![0] as (s: unknown) => any)({ agents: {}, agentSpawnedAt: {} }).agents['settings-agent'];
      expect(agent).not.toHaveProperty('structuredMode');

      // ...and spawnAgent is not asked for structured mode
      expect(mockSpawnAgent).toHaveBeenCalled();
      expect(mockSpawnAgent.mock.calls[0][0]).not.toHaveProperty('structuredMode');
    });

    it('restores mcpIds and branch from durable config', async () => {
      const entry = makeEntry({ agentId: 'settings-agent', resumeStrategy: 'auto' });

      vi.mocked(useAgentStore.subscribe).mockImplementation((callback) => {
        mockAgents['settings-agent'] = { status: 'running' };
        setTimeout(() => (callback as () => void)(), 0);
        return vi.fn();
      });

      await processResumeQueue(makeState([entry]));

      const setStateCalls = mockSetState.mock.calls;
      const agentSetCall = setStateCalls.find((call) => {
        if (typeof call[0] === 'function') {
          const result = call[0]({ agents: {}, agentSpawnedAt: {} });
          const agent = result?.agents?.['settings-agent'];
          return agent?.mcpIds?.includes('mcp-1') && agent?.branch === 'feature/fix-bug';
        }
        return false;
      });
      expect(agentSetCall).toBeDefined();
    });

    it('restores model from durable config when entry has no model', async () => {
      const entry = makeEntry({
        agentId: 'settings-agent',
        resumeStrategy: 'auto',
        model: undefined,
      });

      vi.mocked(useAgentStore.subscribe).mockImplementation((callback) => {
        mockAgents['settings-agent'] = { status: 'running' };
        setTimeout(() => (callback as () => void)(), 0);
        return vi.fn();
      });

      await processResumeQueue(makeState([entry]));

      expect(mockSpawnAgent).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'claude-opus-4' }),
      );
    });

    it('prefers entry model over durable config model', async () => {
      const entry = makeEntry({
        agentId: 'settings-agent',
        resumeStrategy: 'auto',
        model: 'claude-sonnet-4',
      });

      vi.mocked(useAgentStore.subscribe).mockImplementation((callback) => {
        mockAgents['settings-agent'] = { status: 'running' };
        setTimeout(() => (callback as () => void)(), 0);
        return vi.fn();
      });

      await processResumeQueue(makeState([entry]));

      expect(mockSpawnAgent).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'claude-sonnet-4' }),
      );
    });

    it('falls back to gray color when getDurableConfig returns null', async () => {
      mockGetDurableConfig.mockResolvedValue(null);
      const entry = makeEntry({ agentId: 'settings-agent', resumeStrategy: 'auto' });

      vi.mocked(useAgentStore.subscribe).mockImplementation((callback) => {
        mockAgents['settings-agent'] = { status: 'running' };
        setTimeout(() => (callback as () => void)(), 0);
        return vi.fn();
      });

      await processResumeQueue(makeState([entry]));

      const setStateCalls = mockSetState.mock.calls;
      const agentSetCall = setStateCalls.find((call) => {
        if (typeof call[0] === 'function') {
          const result = call[0]({ agents: {}, agentSpawnedAt: {} });
          return result?.agents?.['settings-agent']?.color === 'gray';
        }
        return false;
      });
      expect(agentSetCall).toBeDefined();
    });

    it('falls back gracefully when getDurableConfig throws', async () => {
      mockGetDurableConfig.mockRejectedValue(new Error('config file missing'));
      const entry = makeEntry({ agentId: 'settings-agent', resumeStrategy: 'auto' });

      vi.mocked(useAgentStore.subscribe).mockImplementation((callback) => {
        mockAgents['settings-agent'] = { status: 'running' };
        setTimeout(() => (callback as () => void)(), 0);
        return vi.fn();
      });

      await processResumeQueue(makeState([entry]));

      // Should still succeed — just use defaults
      expect(mockSetResumeStatus).toHaveBeenCalledWith('settings-agent', 'resumed');

      // Color falls back to gray
      const setStateCalls = mockSetState.mock.calls;
      const agentSetCall = setStateCalls.find((call) => {
        if (typeof call[0] === 'function') {
          const result = call[0]({ agents: {}, agentSpawnedAt: {} });
          return result?.agents?.['settings-agent']?.color === 'gray';
        }
        return false;
      });
      expect(agentSetCall).toBeDefined();
    });

    it('does not fetch durable config for non-durable agents', async () => {
      const entry = makeEntry({
        agentId: 'quick-agent',
        kind: 'quick',
        resumeStrategy: 'auto',
      });

      vi.mocked(useAgentStore.subscribe).mockImplementation((callback) => {
        mockAgents['quick-agent'] = { status: 'running' };
        setTimeout(() => (callback as () => void)(), 0);
        return vi.fn();
      });

      await processResumeQueue(makeState([entry]));

      expect(mockGetDurableConfig).not.toHaveBeenCalled();
    });

    it('passes freeAgentMode to spawnAgent in fallback retry', async () => {
      const entry = makeEntry({
        agentId: 'fallback-settings-agent',
        sessionId: 'session-xyz',
        resumeStrategy: 'auto',
      });

      mockGetDurableConfig.mockResolvedValue(durableConfig);

      // First call fails, second succeeds
      mockSpawnAgent
        .mockRejectedValueOnce(new Error('session not found'))
        .mockResolvedValueOnce(undefined);

      vi.mocked(useAgentStore.subscribe).mockImplementation((callback) => {
        mockAgents['fallback-settings-agent'] = { status: 'running' };
        setTimeout(() => (callback as () => void)(), 0);
        return vi.fn();
      });

      await processResumeQueue(makeState([entry]));

      // Second (fallback) call should still include freeAgentMode
      expect(mockSpawnAgent).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          freeAgentMode: true,
          sessionId: undefined,
        }),
      );
      expect(mockSpawnAgent.mock.calls[1][0]).not.toHaveProperty('structuredMode');
    });
  });
});
