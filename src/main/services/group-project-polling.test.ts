import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

const mockIsStopping = vi.hoisted(() => vi.fn((_id?: unknown) => false));
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
const gate = vi.hoisted(() => ({ closed: new Set<string>() }));
vi.mock('./clubhouse-mcp/mcp-call-gate', async (original) => ({
  ...await original<typeof import('./clubhouse-mcp/mcp-call-gate')>(),
  mcpCallAccess: (id: string) => (gate.closed.has(id) ? 'closed' : 'open'),
}));

vi.mock('./pty-manager', () => ({
  write: (...args: unknown[]) => mockPtyWrite(...args),
  getBuffer: vi.fn(() => ''),
  isRunning: (...args: unknown[]) => mockIsRunning(...args),
  isStopping: (...args: unknown[]) => mockIsStopping(...args),
}));

import { agentRegistry } from './agent-registry';
import { bindingManager } from './clubhouse-mcp/binding-manager';
import { groupProjectRegistry } from './group-project-registry';
import {
  setProjectPolling,
  getProjectPollingState,
  _resetPollingForTesting,
  _pendingStartsForTesting,
  _DEFERRED_POLLING_DELAY_MS_FOR_TESTING,
} from './group-project-polling';
import { emitAgentMcpConnected } from './clubhouse-mcp/connection-events';
import { notifyToolGateChange } from './clubhouse-mcp/orchestration-gate';

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
    gate.closed.clear();
    bindingManager._resetForTesting();
    groupProjectRegistry._resetForTesting();
    _resetPollingForTesting();
  });

  describe('a member without Clubhouse MCP', () => {
    const wrote = (id: string, text: string) => mockPtyWrite.mock.calls.some((c: unknown[]) => c[0] === id && typeof c[1] === 'string' && (c[1] as string).includes(text));

    async function offMember(id: string) {
      const project = await groupProjectRegistry.create('Off');
      agentRegistry.register(id, { projectPath: '/t', orchestrator: 'claude-code', runtime: 'pty' });
      mockIsRunning.mockImplementation((agent: string) => agent === id);
      bindMember(project.id, id, 'off-member');
      gate.closed.add(id);
      return project;
    }

    afterEach(() => { vi.useRealTimers(); });

    it('gets no start instruction, and its membership and status are untouched', async () => {
      const project = await offMember('m-off');
      const state = await setProjectPolling(project.id, true);
      expect(wrote('m-off', 'start polling')).toBe(false);
      expect(state?.members).toEqual([{ agentId: 'm-off', agentName: 'off-member', status: 'connected' }]);
      expect(_pendingStartsForTesting.get('m-off')?.has(project.id)).toBe(true);
    });

    it('gets it when MCP is back, with no restart, and only once', async () => {
      vi.useFakeTimers();
      const project = await offMember('m-back');
      await setProjectPolling(project.id, true);

      // A change that leaves it off sends nothing, and keeps it held.
      notifyToolGateChange('m-back');
      await vi.advanceTimersByTimeAsync(_DEFERRED_POLLING_DELAY_MS_FOR_TESTING + 10);
      expect(wrote('m-back', 'start polling')).toBe(false);
      expect(_pendingStartsForTesting.has('m-back')).toBe(true);

      gate.closed.delete('m-back');
      notifyToolGateChange('m-back');
      await vi.advanceTimersByTimeAsync(_DEFERRED_POLLING_DELAY_MS_FOR_TESTING + 10);
      expect(wrote('m-back', 'start polling')).toBe(true);
      expect(_pendingStartsForTesting.has('m-back')).toBe(false);

      mockPtyWrite.mockClear();
      notifyToolGateChange('m-back');
      await vi.advanceTimersByTimeAsync(_DEFERRED_POLLING_DELAY_MS_FOR_TESTING + 10);
      expect(wrote('m-back', 'start polling')).toBe(false);
    });

    it('wakes nothing: one that stopped while MCP was off gets it at its next handshake', async () => {
      vi.useFakeTimers();
      const project = await offMember('m-gone');
      await setProjectPolling(project.id, true);
      agentRegistry.untrack('m-gone');
      mockIsRunning.mockReturnValue(false);
      gate.closed.delete('m-gone');
      notifyToolGateChange('m-gone');
      await vi.advanceTimersByTimeAsync(_DEFERRED_POLLING_DELAY_MS_FOR_TESTING + 10);
      expect(mockPtyWrite).not.toHaveBeenCalled();
      expect(_pendingStartsForTesting.has('m-gone')).toBe(true);
      expect(agentRegistry.get('m-gone')).toBeUndefined();

      agentRegistry.register('m-gone', { projectPath: '/t', orchestrator: 'claude-code', runtime: 'pty' });
      mockIsRunning.mockImplementation((agent: string) => agent === 'm-gone');
      emitAgentMcpConnected('m-gone');
      await vi.advanceTimersByTimeAsync(_DEFERRED_POLLING_DELAY_MS_FOR_TESTING + 10);
      expect(wrote('m-gone', 'start polling')).toBe(true);
    });

    it('a handshake while MCP is still off sends nothing', async () => {
      vi.useFakeTimers();
      const project = await offMember('m-shake');
      await setProjectPolling(project.id, true);
      emitAgentMcpConnected('m-shake');
      await vi.advanceTimersByTimeAsync(_DEFERRED_POLLING_DELAY_MS_FOR_TESTING + 10);
      expect(wrote('m-shake', 'start polling')).toBe(false);
      expect(_pendingStartsForTesting.has('m-shake')).toBe(true);
    });

    it('polling turned off meanwhile drops the held start, and the stop instruction still goes out', async () => {
      vi.useFakeTimers();
      const project = await offMember('m-stop');
      await setProjectPolling(project.id, true);
      await setProjectPolling(project.id, false);
      expect(wrote('m-stop', 'stop p')).toBe(true);
      gate.closed.delete('m-stop');
      notifyToolGateChange('m-stop');
      await vi.advanceTimersByTimeAsync(_DEFERRED_POLLING_DELAY_MS_FOR_TESTING + 10);
      expect(wrote('m-stop', 'start polling')).toBe(false);
    });

    it('a member with MCP still gets it at once, beside one without', async () => {
      const project = await offMember('m-off2');
      agentRegistry.register('m-on', { projectPath: '/t', orchestrator: 'claude-code', runtime: 'pty' });
      mockIsRunning.mockImplementation((agent: string) => agent === 'm-off2' || agent === 'm-on');
      bindMember(project.id, 'm-on', 'on-member');
      await setProjectPolling(project.id, true);
      expect(wrote('m-on', 'start polling')).toBe(true);
      expect(wrote('m-off2', 'start polling')).toBe(false);
    });
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

  describe('members asleep when polling is turned on', () => {
    const starts = () => mockPtyWrite.mock.calls.filter((c: unknown[]) => String(c[1]).includes('start polling'));

    async function connectAndWait(agentId: string): Promise<void> {
      vi.useFakeTimers();
      try {
        emitAgentMcpConnected(agentId);
        await vi.advanceTimersByTimeAsync(_DEFERRED_POLLING_DELAY_MS_FOR_TESTING + 100);
      } finally {
        vi.useRealTimers();
      }
    }

    it('get the start message after their next MCP handshake, once', async () => {
      const project = await groupProjectRegistry.create('Bridge');
      bindMember(project.id, 'sleepy', 'sleepy');
      await setProjectPolling(project.id, true);
      expect(starts()).toHaveLength(0);
      expect(_pendingStartsForTesting.get('sleepy')?.has(project.id)).toBe(true);

      await connectAndWait('sleepy');
      await connectAndWait('sleepy');
      expect(starts()).toHaveLength(1);
      expect(starts()[0][0]).toBe('sleepy');
      expect(String(starts()[0][1])).toContain('inbox-sleepy');
    });

    it('get nothing if polling is turned off before they wake', async () => {
      const project = await groupProjectRegistry.create('Bridge');
      bindMember(project.id, 'sleepy', 'sleepy');
      await setProjectPolling(project.id, true);
      await setProjectPolling(project.id, false);
      expect(_pendingStartsForTesting.size).toBe(0);
      await connectAndWait('sleepy');
      expect(starts()).toHaveLength(0);
    });

    it('get nothing for a handshake when the user never toggled polling', async () => {
      const project = await groupProjectRegistry.create('Bridge');
      await groupProjectRegistry.update(project.id, { metadata: { pollingEnabled: true } });
      bindMember(project.id, 'sleepy', 'sleepy');
      await connectAndWait('sleepy');
      expect(mockPtyWrite).not.toHaveBeenCalled();
    });
  });
});
