import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsp from 'fs/promises';
import * as path from 'path';

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/test-userdata',
    getVersion: () => '0.38.0',
  },
}));

vi.mock('./log-service', () => ({
  appLog: vi.fn(),
}));

vi.mock('./fs-utils', () => ({
  pathExists: vi.fn().mockResolvedValue(true),
}));

vi.mock('./agent-registry', () => {
  const registrations = new Map();
  return {
    agentRegistry: {
      getAllRegistrations: () => new Map(registrations),
      get: (id: string) => registrations.get(id),
      register: (id: string, reg: unknown) => registrations.set(id, reg),
      untrack: (id: string) => registrations.delete(id),
    },
  };
});

vi.mock('./pty-manager', () => ({
  getBuffer: vi.fn().mockReturnValue(''),
  getLastActivity: vi.fn().mockReturnValue(null),
  isRunning: vi.fn().mockReturnValue(false),
}));

vi.mock('../orchestrators', () => ({
  getProvider: vi.fn().mockReturnValue({
    id: 'claude-code',
    capabilities: { sessionResume: true, supportsAutoResumeAfterUpdate: true },
    extractSessionId: vi.fn().mockReturnValue(null),
  }),
  isSessionCapable: vi.fn().mockReturnValue(true),
  supportsAutoResumeAfterUpdate: vi.fn((provider: any) => provider.capabilities?.supportsAutoResumeAfterUpdate ?? provider.capabilities?.sessionResume ?? false),
  supportsPositionalMission: vi.fn((provider: any) => provider.capabilities?.supportsPositionalMission ?? false),
}));

vi.mock('./agent-config', () => ({
  getDurableConfig: vi.fn().mockResolvedValue(null),
}));

vi.mock('./headless-manager', () => ({
  isHeadless: vi.fn().mockReturnValue(false),
}));

vi.mock('./agent-runtime', async () => {
  const actual = await vi.importActual<typeof import('./agent-runtime')>('./agent-runtime');
  return { ...actual, getAgentRuntime: vi.fn((id: string) => actual.getAgentRuntime(id)) };
});

import { captureSessionState, loadPendingResume, clearPendingResume, getLiveAgentsForUpdate } from './restart-session-service';
import { agentRegistry } from './agent-registry';
import * as ptyManager from './pty-manager';
import { getProvider, isSessionCapable } from '../orchestrators';
import { pathExists } from './fs-utils';
import { getDurableConfig } from './agent-config';
import * as headlessManager from './headless-manager';
import { getAgentRuntime } from './agent-runtime';
import type { AgentRuntime } from '../../shared/chat';

describe('restart-session-service', () => {
  const statePath = '/tmp/test-userdata/restart-session-state.json';

  beforeEach(() => {
    vi.clearAllMocks();
    for (const [id] of agentRegistry.getAllRegistrations()) {
      agentRegistry.untrack(id);
    }
  });

  afterEach(async () => {
    try { await fsp.unlink(statePath); } catch {}
  });

  describe('captureSessionState', () => {
    it('writes state file with PTY agents only', async () => {
      agentRegistry.register('darling-gazelle', {
        projectPath: '/projects/club',
        orchestrator: 'claude-code' as const,
        runtime: 'pty',
      });
      agentRegistry.register('headless-one', {
        projectPath: '/projects/club',
        orchestrator: 'claude-code' as const,
        runtime: 'headless',
      });

      const provider = {
        id: 'claude-code',
        capabilities: { sessionResume: true },
        extractSessionId: vi.fn().mockReturnValue('session-abc'),
      };
      vi.mocked(getProvider).mockReturnValue(provider as never);
      vi.mocked(isSessionCapable).mockReturnValue(true);
      vi.mocked(ptyManager.getBuffer).mockReturnValue('session: session-abc');
      vi.mocked(ptyManager.getLastActivity).mockReturnValue(Date.now());

      const agentNames = new Map([['darling-gazelle', 'darling-gazelle']]);
      await captureSessionState(agentNames);

      const raw = await fsp.readFile(statePath, 'utf-8');
      const state = JSON.parse(raw);

      expect(state.version).toBe(1);
      expect(state.sessions).toHaveLength(1);
      expect(state.sessions[0].agentId).toBe('darling-gazelle');
      expect(state.sessions[0].sessionId).toBe('session-abc');
      expect(state.sessions[0].resumeStrategy).toBe('auto');
    });

    it('captures freeAgentMode from durable config', async () => {
      agentRegistry.register('free-agent-test', {
        projectPath: '/projects/club',
        orchestrator: 'claude-code' as const,
        runtime: 'pty',
      });

      const provider = {
        id: 'claude-code',
        capabilities: { sessionResume: true },
        extractSessionId: vi.fn().mockReturnValue(null),
      };
      vi.mocked(getProvider).mockReturnValue(provider as never);
      vi.mocked(isSessionCapable).mockReturnValue(true);
      vi.mocked(getDurableConfig).mockResolvedValue({
        id: 'free-agent-test',
        name: 'Free Agent',
        color: 'red',
        createdAt: new Date().toISOString(),
        freeAgentMode: true,
      } as never);

      const agentNames = new Map([['free-agent-test', 'Free Agent']]);
      await captureSessionState(agentNames);

      const raw = await fsp.readFile(statePath, 'utf-8');
      const state = JSON.parse(raw);

      expect(state.sessions[0].freeAgentMode).toBe(true);
    });

    it('omits freeAgentMode when durable config is unavailable', async () => {
      agentRegistry.register('no-config-agent', {
        projectPath: '/projects/club',
        orchestrator: 'claude-code' as const,
        runtime: 'pty',
      });

      const provider = {
        id: 'claude-code',
        capabilities: { sessionResume: true },
        extractSessionId: vi.fn().mockReturnValue(null),
      };
      vi.mocked(getProvider).mockReturnValue(provider as never);
      vi.mocked(isSessionCapable).mockReturnValue(true);
      vi.mocked(getDurableConfig).mockRejectedValue(new Error('ENOENT'));

      const agentNames = new Map([['no-config-agent', 'No Config']]);
      await captureSessionState(agentNames);

      const raw = await fsp.readFile(statePath, 'utf-8');
      const state = JSON.parse(raw);

      expect(state.sessions[0].freeAgentMode).toBeUndefined();
    });

    it('captures freeAgentMode as undefined when config has no freeAgentMode', async () => {
      agentRegistry.register('normal-agent', {
        projectPath: '/projects/club',
        orchestrator: 'claude-code' as const,
        runtime: 'pty',
      });

      const provider = {
        id: 'claude-code',
        capabilities: { sessionResume: true },
        extractSessionId: vi.fn().mockReturnValue(null),
      };
      vi.mocked(getProvider).mockReturnValue(provider as never);
      vi.mocked(isSessionCapable).mockReturnValue(true);
      vi.mocked(getDurableConfig).mockResolvedValue({
        id: 'normal-agent',
        name: 'Normal Agent',
        color: 'blue',
        createdAt: new Date().toISOString(),
      } as never);

      const agentNames = new Map([['normal-agent', 'Normal Agent']]);
      await captureSessionState(agentNames);

      const raw = await fsp.readFile(statePath, 'utf-8');
      const state = JSON.parse(raw);

      expect(state.sessions[0].freeAgentMode).toBeUndefined();
    });

    it('sets manual strategy when orchestrator lacks session capability', async () => {
      agentRegistry.register('mega-camel', {
        projectPath: '/projects/club',
        orchestrator: 'copilot-cli' as const,
        runtime: 'pty',
      });

      const provider = {
        id: 'copilot-cli',
        capabilities: { sessionResume: false },
      };
      vi.mocked(getProvider).mockReturnValue(provider as never);
      vi.mocked(isSessionCapable).mockReturnValue(false);

      const agentNames = new Map([['mega-camel', 'mega-camel']]);
      await captureSessionState(agentNames);

      const raw = await fsp.readFile(statePath, 'utf-8');
      const state = JSON.parse(raw);

      expect(state.sessions[0].resumeStrategy).toBe('manual');
      expect(state.sessions[0].sessionId).toBeNull();
    });
  });

  describe('loadPendingResume', () => {
    it('returns null when file does not exist', async () => {
      const result = await loadPendingResume();
      expect(result).toBeNull();
    });

    it('returns null and deletes file when version mismatches', async () => {
      await fsp.mkdir(path.dirname(statePath), { recursive: true });
      await fsp.writeFile(statePath, JSON.stringify({
        version: 999,
        capturedAt: new Date().toISOString(),
        appVersion: '0.38.0',
        sessions: [],
      }));

      const result = await loadPendingResume();
      expect(result).toBeNull();
    });

    it('returns null and deletes file when stale (>24h)', async () => {
      await fsp.mkdir(path.dirname(statePath), { recursive: true });
      const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      await fsp.writeFile(statePath, JSON.stringify({
        version: 1,
        capturedAt: staleDate,
        appVersion: '0.38.0',
        sessions: [{ agentId: 'test', resumeStrategy: 'auto' }],
      }));

      const result = await loadPendingResume();
      expect(result).toBeNull();
    });

    it('returns sessions when file is valid and fresh', async () => {
      await fsp.mkdir(path.dirname(statePath), { recursive: true });
      await fsp.writeFile(statePath, JSON.stringify({
        version: 1,
        capturedAt: new Date().toISOString(),
        appVersion: '0.38.0',
        sessions: [{ agentId: 'darling-gazelle', resumeStrategy: 'auto', sessionId: 'abc', projectPath: '/projects/club' }],
      }));

      // pathExists must return true so directory validation doesn't filter out the session
      vi.mocked(pathExists).mockResolvedValue(true);

      const result = await loadPendingResume();
      expect(result).not.toBeNull();
      expect(result!.sessions).toHaveLength(1);
      expect(result!.sessions[0].agentId).toBe('darling-gazelle');
    });
  });

  describe('clearPendingResume', () => {
    it('deletes the state file', async () => {
      await fsp.mkdir(path.dirname(statePath), { recursive: true });
      await fsp.writeFile(statePath, '{}');

      await clearPendingResume();

      await expect(fsp.access(statePath)).rejects.toThrow();
    });

    it('does not throw when file does not exist', async () => {
      await expect(clearPendingResume()).resolves.not.toThrow();
    });
  });

  describe('getLiveAgentsForUpdate', () => {
    it('returns empty array when no agents are registered', () => {
      const result = getLiveAgentsForUpdate();
      expect(result).toEqual([]);
    });

    it('lists terminal, chat and headless agents the restart stops (#2053)', () => {
      const reg = (runtime: string) => ({ projectPath: '/projects/club', orchestrator: 'claude-code' as const, runtime });
      agentRegistry.register('pty-agent', reg('pty'));
      agentRegistry.register('chat-busy', reg('chat'));
      agentRegistry.register('chat-idle', reg('chat'));
      agentRegistry.register('chat-ended', reg('chat'));
      agentRegistry.register('headless-agent', reg('headless'));
      agentRegistry.register('headless-gone', reg('headless'));
      const chat = (running: boolean, state: string) => ({ kind: 'chat', isRunning: () => running, getState: () => state }) as unknown as AgentRuntime;
      const chats: Record<string, AgentRuntime> = {
        'chat-busy': chat(true, 'waiting_permission'),
        'chat-idle': chat(true, 'idle'),
        'chat-ended': chat(false, 'sleeping'),
      };
      vi.mocked(getAgentRuntime).mockImplementation((id: string) => chats[id]);
      vi.mocked(headlessManager.isHeadless).mockImplementation((id: string) => id === 'headless-agent');
      vi.mocked(ptyManager.getLastActivity).mockReturnValue(null);

      const byId = Object.fromEntries(getLiveAgentsForUpdate().map((a) => [a.agentId, a]));

      expect(Object.keys(byId).sort()).toEqual(['chat-busy', 'chat-idle', 'headless-agent', 'pty-agent']);
      expect(byId['chat-busy']).toMatchObject({ runtime: 'chat', isWorking: true });
      expect(byId['chat-idle']).toMatchObject({ runtime: 'chat', isWorking: false });
      // Chat resumes the way a terminal on the same provider does.
      expect(byId['chat-busy'].resumeStrategy).toBe(byId['pty-agent'].resumeStrategy);
      // A headless run ends with the restart; it isn't resumed.
      expect(byId['headless-agent']).toMatchObject({ runtime: 'headless', isWorking: true, resumeStrategy: 'manual' });
      expect(byId['pty-agent']).toMatchObject({ runtime: 'pty', isWorking: false });
      vi.mocked(getAgentRuntime).mockReset();
    });

    it('classifies agent as working when lastActivity is within 5 seconds', () => {
      agentRegistry.register('active-agent', {
        projectPath: '/projects/club',
        orchestrator: 'claude-code' as const,
        runtime: 'pty',
      });

      const recentActivity = Date.now() - 2000; // 2 seconds ago — within threshold
      vi.mocked(ptyManager.getLastActivity).mockReturnValue(recentActivity);

      const result = getLiveAgentsForUpdate();

      expect(result).toHaveLength(1);
      expect(result[0].agentId).toBe('active-agent');
      expect(result[0].isWorking).toBe(true);
      expect(result[0].lastActivity).toBe(recentActivity);
    });

    it('classifies agent as idle when lastActivity is older than 5 seconds', () => {
      agentRegistry.register('idle-agent', {
        projectPath: '/projects/club',
        orchestrator: 'claude-code' as const,
        runtime: 'pty',
      });

      const oldActivity = Date.now() - 10000; // 10 seconds ago — beyond threshold
      vi.mocked(ptyManager.getLastActivity).mockReturnValue(oldActivity);

      const result = getLiveAgentsForUpdate();

      expect(result).toHaveLength(1);
      expect(result[0].agentId).toBe('idle-agent');
      expect(result[0].isWorking).toBe(false);
      expect(result[0].lastActivity).toBe(oldActivity);
    });

    it('classifies agent as idle when lastActivity is null (no PTY data yet)', () => {
      agentRegistry.register('no-activity-agent', {
        projectPath: '/projects/club',
        orchestrator: 'claude-code' as const,
        runtime: 'pty',
      });

      vi.mocked(ptyManager.getLastActivity).mockReturnValue(null);

      const result = getLiveAgentsForUpdate();

      expect(result).toHaveLength(1);
      expect(result[0].agentId).toBe('no-activity-agent');
      expect(result[0].isWorking).toBe(false);
      expect(result[0].lastActivity).toBeNull();
    });

    it('handles multiple agents across different projects', () => {
      agentRegistry.register('agent-alpha', {
        projectPath: '/projects/alpha',
        orchestrator: 'claude-code' as const,
        runtime: 'pty',
      });
      agentRegistry.register('agent-beta', {
        projectPath: '/projects/beta',
        orchestrator: 'claude-code' as const,
        runtime: 'pty',
      });
      agentRegistry.register('agent-gamma-headless', {
        projectPath: '/projects/gamma',
        orchestrator: 'claude-code' as const,
        runtime: 'headless',
      });

      const now = Date.now();
      vi.mocked(ptyManager.getLastActivity).mockImplementation((agentId: string) => {
        if (agentId === 'agent-alpha') return now - 1000; // working (1 second ago)
        if (agentId === 'agent-beta') return now - 20000; // idle (20 seconds ago)
        return null;
      });

      const result = getLiveAgentsForUpdate();

      expect(result).toHaveLength(2);

      const alpha = result.find((r) => r.agentId === 'agent-alpha');
      const beta = result.find((r) => r.agentId === 'agent-beta');

      expect(alpha).toBeDefined();
      expect(alpha!.projectPath).toBe('/projects/alpha');
      expect(alpha!.isWorking).toBe(true);

      expect(beta).toBeDefined();
      expect(beta!.projectPath).toBe('/projects/beta');
      expect(beta!.isWorking).toBe(false);

      // Headless agent must not appear
      expect(result.find((r) => r.agentId === 'agent-gamma-headless')).toBeUndefined();
    });

    it('reports auto-resume for any provider that can resume sessions', () => {
      vi.mocked(isSessionCapable).mockReturnValue(true);
      vi.mocked(getProvider).mockReturnValue({
        id: 'codex-cli',
        capabilities: { sessionResume: true, supportsAutoResumeAfterUpdate: true },
      } as never);
      agentRegistry.register('agent-codex', {
        runtime: 'pty', projectPath: '/proj', orchestrator: 'codex-cli',
      });

      const [entry] = getLiveAgentsForUpdate().filter((r) => r.agentId === 'agent-codex');
      // Previously hardcoded to claude-code in UpdateBanner, so Codex showed
      // "Manual resume" while the capture path already treated it as auto.
      expect(entry.resumeStrategy).toBe('auto');
    });

    it('reports manual resume when the provider cannot resume sessions', () => {
      vi.mocked(isSessionCapable).mockReturnValue(false);
      vi.mocked(getProvider).mockReturnValue({ id: 'basic-cli' } as never);
      agentRegistry.register('agent-basic', {
        runtime: 'pty', projectPath: '/proj', orchestrator: 'basic-cli',
      });

      const [entry] = getLiveAgentsForUpdate().filter((r) => r.agentId === 'agent-basic');
      expect(entry.resumeStrategy).toBe('manual');
    });

    it('agrees with the strategy the capture path records', async () => {
      vi.mocked(isSessionCapable).mockReturnValue(true);
      vi.mocked(getProvider).mockReturnValue({
        id: 'codex-cli',
        extractSessionId: vi.fn().mockReturnValue(null),
        listSessions: vi.fn().mockResolvedValue([]),
      } as never);
      agentRegistry.register('agent-both', {
        runtime: 'pty', projectPath: '/proj', orchestrator: 'codex-cli',
      });

      const [preview] = getLiveAgentsForUpdate().filter((r) => r.agentId === 'agent-both');
      await captureSessionState(new Map());
      const written = JSON.parse(await fsp.readFile(statePath, 'utf-8'));
      const captured = written.sessions.find((x: { agentId: string }) => x.agentId === 'agent-both');

      // The badge shown before restarting must match what actually happens.
      expect(preview.resumeStrategy).toBe(captured.resumeStrategy);
    });
  });

  describe('session id resolution', () => {
    it('falls back to the provider session list when the CLI prints no id', async () => {
      // Codex's TUI prints no session id, so the buffer scrape finds nothing.
      vi.mocked(isSessionCapable).mockReturnValue(true);
      vi.mocked(ptyManager.getBuffer).mockReturnValue('no id in here');
      const listSessions = vi.fn().mockResolvedValue([
        { sessionId: 'newest-session', startedAt: 'a', lastActiveAt: 'b' },
        { sessionId: 'older-session', startedAt: 'c', lastActiveAt: 'd' },
      ]);
      vi.mocked(getProvider).mockReturnValue({
        id: 'codex-cli',
        capabilities: { sessionResume: true },
        extractSessionId: vi.fn().mockReturnValue(null),
        listSessions,
      } as never);

      agentRegistry.register('agent-fallback', {
        runtime: 'pty', projectPath: '/proj', orchestrator: 'codex-cli',
      });
      await captureSessionState(new Map());

      const written = JSON.parse(await fsp.readFile(statePath, 'utf-8'));
      const entry = written.sessions.find((x: { agentId: string }) => x.agentId === 'agent-fallback');
      // Without this the resume degrades to "most recent session in this cwd",
      // which picks the wrong conversation when agents share a directory.
      expect(entry.sessionId).toBe('newest-session');
      expect(entry.sessionStarted).toBe(true);
    });

    // #2074: an agent still starting at restart has no session; resuming would
    // drop its mission, so the entry says it never started.
    it('records sessionStarted: false when no session exists on disk for the agent', async () => {
      vi.mocked(isSessionCapable).mockReturnValue(true);
      vi.mocked(ptyManager.getBuffer).mockReturnValue('still booting');
      vi.mocked(getProvider).mockReturnValue({
        id: 'claude-code',
        capabilities: { sessionResume: true },
        extractSessionId: vi.fn().mockReturnValue(null),
        listSessions: vi.fn().mockResolvedValue([]),
      } as never);

      agentRegistry.register('agent-starting', {
        runtime: 'pty', projectPath: '/proj', orchestrator: 'claude-code',
      });
      await captureSessionState(new Map(), new Map([['agent-starting', { kind: 'durable' as const, mission: 'Do the thing' }]]));

      const written = JSON.parse(await fsp.readFile(statePath, 'utf-8'));
      const entry = written.sessions.find((x: { agentId: string }) => x.agentId === 'agent-starting');
      expect(entry).toMatchObject({ sessionId: null, sessionStarted: false, mission: 'Do the thing' });
    });

    it('prefers the id the CLI printed over the session list', async () => {
      vi.mocked(isSessionCapable).mockReturnValue(true);
      const listSessions = vi.fn().mockResolvedValue([
        { sessionId: 'from-disk', startedAt: 'a', lastActiveAt: 'b' },
      ]);
      vi.mocked(getProvider).mockReturnValue({
        id: 'claude-code',
        capabilities: { sessionResume: true },
        extractSessionId: vi.fn().mockReturnValue('from-buffer'),
        listSessions,
      } as never);

      agentRegistry.register('agent-scraped', {
        runtime: 'pty', projectPath: '/proj', orchestrator: 'claude-code',
      });
      await captureSessionState(new Map());

      const written = JSON.parse(await fsp.readFile(statePath, 'utf-8'));
      const entry = written.sessions.find((x: { agentId: string }) => x.agentId === 'agent-scraped');
      expect(entry.sessionId).toBe('from-buffer');
      expect(listSessions).not.toHaveBeenCalled();
    });

    it('still captures the agent when the session lookup fails', async () => {
      vi.mocked(isSessionCapable).mockReturnValue(true);
      vi.mocked(getProvider).mockReturnValue({
        id: 'codex-cli',
        capabilities: { sessionResume: true },
        extractSessionId: vi.fn().mockReturnValue(null),
        listSessions: vi.fn().mockRejectedValue(new Error('store unreadable')),
      } as never);

      agentRegistry.register('agent-broken-store', {
        runtime: 'pty', projectPath: '/proj', orchestrator: 'codex-cli',
      });
      await captureSessionState(new Map());

      const written = JSON.parse(await fsp.readFile(statePath, 'utf-8'));
      const entry = written.sessions.find((x: { agentId: string }) => x.agentId === 'agent-broken-store');
      // A failed lookup degrades to resume-most-recent, never to losing the agent.
      expect(entry).toBeDefined();
      expect(entry.sessionId).toBeNull();
      expect(entry.resumeStrategy).toBe('auto');
      // Can't tell whether a session exists: left unset, so the queue resumes the most recent one
      expect(entry.sessionStarted).toBeUndefined();
    });
  });
});
