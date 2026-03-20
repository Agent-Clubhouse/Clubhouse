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
    capabilities: { sessionResume: true },
    extractSessionId: vi.fn().mockReturnValue(null),
  }),
  isSessionCapable: vi.fn().mockReturnValue(true),
}));

import { captureSessionState, loadPendingResume, clearPendingResume, getLiveAgentsForUpdate } from './restart-session-service';
import { agentRegistry } from './agent-registry';
import * as ptyManager from './pty-manager';
import { getProvider, isSessionCapable } from '../orchestrators';
import { pathExists } from './fs-utils';

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

    it('returns only PTY agents, filtering out headless and structured runtimes', () => {
      agentRegistry.register('pty-agent', {
        projectPath: '/projects/club',
        orchestrator: 'claude-code' as const,
        runtime: 'pty',
      });
      agentRegistry.register('headless-agent', {
        projectPath: '/projects/club',
        orchestrator: 'claude-code' as const,
        runtime: 'headless',
      });
      agentRegistry.register('structured-agent', {
        projectPath: '/projects/club',
        orchestrator: 'claude-code' as const,
        runtime: 'structured',
      });

      vi.mocked(ptyManager.getLastActivity).mockReturnValue(null);

      const result = getLiveAgentsForUpdate();

      expect(result).toHaveLength(1);
      expect(result[0].agentId).toBe('pty-agent');
      expect(result[0].runtime).toBe('pty');
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
  });
});
