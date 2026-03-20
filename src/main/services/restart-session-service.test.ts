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

import { captureSessionState, loadPendingResume, clearPendingResume } from './restart-session-service';
import { agentRegistry } from './agent-registry';
import * as ptyManager from './pty-manager';
import { getProvider, isSessionCapable } from '../orchestrators';

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
        sessions: [{ agentId: 'darling-gazelle', resumeStrategy: 'auto', sessionId: 'abc' }],
      }));

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
});
