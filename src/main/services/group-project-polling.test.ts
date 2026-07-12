import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp/test-clubhouse',
  },
}));

// In-memory fs so the registry can "persist".
const store = new Map<string, string>();
vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockImplementation(async (p: string) => {
    if (!store.has(p)) throw new Error('ENOENT');
  }),
  readFile: vi.fn().mockImplementation(async (p: string) => {
    const data = store.get(p);
    if (!data) throw new Error('ENOENT');
    return data;
  }),
  writeFile: vi.fn().mockImplementation(async (p: string, content: string) => {
    store.set(p, content);
  }),
}));

vi.mock('./log-service', () => ({
  appLog: vi.fn(),
}));

const mockPtyWrite = vi.fn();
const mockIsRunning = vi.fn().mockReturnValue(false);
vi.mock('./pty-manager', () => ({
  write: (...args: unknown[]) => mockPtyWrite(...args),
  getBuffer: vi.fn(() => ''),
  isRunning: (...args: unknown[]) => mockIsRunning(...args),
}));

import { agentRegistry } from './agent-registry';
import { bindingManager } from './clubhouse-mcp/binding-manager';
import { groupProjectRegistry } from './group-project-registry';
import { setProjectPolling, getProjectPollingState } from './group-project-polling';

function bindMember(projectId: string, agentId: string, agentName: string): void {
  bindingManager.bind(agentId, {
    targetId: projectId,
    targetKind: 'group-project',
    label: 'P',
    agentName,
    targetName: 'P',
  });
}

describe('group-project-polling', () => {
  beforeEach(() => {
    store.clear();
    mockPtyWrite.mockClear();
    mockIsRunning.mockReturnValue(false);
    bindingManager._resetForTesting();
    groupProjectRegistry._resetForTesting();
  });

  describe('setProjectPolling', () => {
    it('persists pollingEnabled=true', async () => {
      const project = await groupProjectRegistry.create('P1');
      const state = await setProjectPolling(project.id, true);
      expect(state?.pollingEnabled).toBe(true);
      const persisted = await groupProjectRegistry.get(project.id);
      expect(persisted?.metadata?.pollingEnabled).toBe(true);
    });

    it('persists pollingEnabled=false', async () => {
      const project = await groupProjectRegistry.create('P2');
      await groupProjectRegistry.update(project.id, { metadata: { pollingEnabled: true } });
      const state = await setProjectPolling(project.id, false);
      expect(state?.pollingEnabled).toBe(false);
      const persisted = await groupProjectRegistry.get(project.id);
      expect(persisted?.metadata?.pollingEnabled).toBe(false);
    });

    it('injects a start instruction to connected members and skips sleeping ones', async () => {
      const project = await groupProjectRegistry.create('P3');
      agentRegistry.register('a-live', { projectPath: '/t', orchestrator: 'claude-code', runtime: 'pty' });
      mockIsRunning.mockImplementation((id: string) => id === 'a-live');
      bindMember(project.id, 'a-live', 'live');
      bindMember(project.id, 'a-sleep', 'sleepy');

      const state = await setProjectPolling(project.id, true);

      // Only the connected member is injected + reported connected
      const startWrite = mockPtyWrite.mock.calls.find(
        (c: unknown[]) => typeof c[1] === 'string' && (c[1] as string).includes('start polling'),
      );
      expect(startWrite).toBeDefined();
      expect(startWrite![0]).toBe('a-live');
      expect(mockPtyWrite.mock.calls.some((c: unknown[]) => c[0] === 'a-sleep')).toBe(false);

      const statuses = Object.fromEntries((state?.members ?? []).map((m) => [m.agentId, m.status]));
      expect(statuses['a-live']).toBe('connected');
      expect(statuses['a-sleep']).toBe('sleeping');

      agentRegistry.untrack('a-live');
    });

    it('injects a stop instruction to connected members when disabling', async () => {
      const project = await groupProjectRegistry.create('P4');
      agentRegistry.register('a-live', { projectPath: '/t', orchestrator: 'claude-code', runtime: 'pty' });
      mockIsRunning.mockImplementation((id: string) => id === 'a-live');
      bindMember(project.id, 'a-live', 'live');

      await setProjectPolling(project.id, false);

      const stopWrite = mockPtyWrite.mock.calls.find(
        (c: unknown[]) => typeof c[1] === 'string' && (c[1] as string).includes('stop polling'),
      );
      expect(stopWrite).toBeDefined();
      expect(stopWrite![0]).toBe('a-live');

      agentRegistry.untrack('a-live');
    });

    it('returns null for an unknown project', async () => {
      expect(await setProjectPolling('gp_missing', true)).toBeNull();
    });
  });

  describe('getProjectPollingState', () => {
    it('returns the current flag and member connection statuses', async () => {
      const project = await groupProjectRegistry.create('Q1');
      await groupProjectRegistry.update(project.id, { metadata: { pollingEnabled: true } });
      agentRegistry.register('a-live', { projectPath: '/t', orchestrator: 'claude-code', runtime: 'pty' });
      mockIsRunning.mockImplementation((id: string) => id === 'a-live');
      bindMember(project.id, 'a-live', 'live');
      bindMember(project.id, 'a-sleep', 'sleepy');

      const state = await getProjectPollingState(project.id);
      expect(state?.pollingEnabled).toBe(true);
      const statuses = Object.fromEntries((state?.members ?? []).map((m) => [m.agentId, m.status]));
      expect(statuses).toEqual({ 'a-live': 'connected', 'a-sleep': 'sleeping' });

      agentRegistry.untrack('a-live');
    });

    it('reports pollingEnabled=false when unset', async () => {
      const project = await groupProjectRegistry.create('Q2');
      const state = await getProjectPollingState(project.id);
      expect(state?.pollingEnabled).toBe(false);
    });

    it('returns null for an unknown project', async () => {
      expect(await getProjectPollingState('gp_missing')).toBeNull();
    });
  });
});
