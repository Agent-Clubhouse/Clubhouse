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
  listPausedPolling,
  onPollingPauseChanged,
  resumePausedPolling,
  watchPollingForMcp,
  _resetPollingForTesting,
  _pendingStartsForTesting,
  _DEFERRED_POLLING_DELAY_MS_FOR_TESTING,
} from './group-project-polling';
import { emitAgentMcpConnected } from './clubhouse-mcp/connection-events';
import { notifyToolGateChange } from './clubhouse-mcp/orchestration-gate';
import { POLLING_LIVE_WINDOW_MS, notePollingRead } from './group-project-polling-runs';

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

    describe('losing MCP while it polls', () => {
      let nonce = 0;
      /** A new start: a new nonce, as spawnAgent gives one. */
      function start(id: string) {
        agentRegistry.register(id, { projectPath: '/t', orchestrator: 'claude-code', runtime: 'pty' });
        agentRegistry.setNonce(id, `nonce-${++nonce}`);
        mockIsRunning.mockImplementation((agent: string) => agent === id);
      }
      async function polling(id: string, name = 'Looping') {
        const project = await groupProjectRegistry.create(name);
        start(id);
        bindMember(project.id, id, 'looper');
        await setProjectPolling(project.id, true);
        mockPtyWrite.mockClear();
        watchPollingForMcp();
        return project;
      }
      /** Instructions written, leaving out the Enter that follows each. */
      const instructions = () => mockPtyWrite.mock.calls.filter((c: unknown[]) => typeof c[1] === 'string' && (c[1] as string).includes('Group Project notification'));
      const count = (id: string, text: string) => mockPtyWrite.mock.calls.filter((c: unknown[]) => c[0] === id && typeof c[1] === 'string' && (c[1] as string).includes(text)).length;
      const lose = async (id: string) => { gate.closed.add(id); notifyToolGateChange(id); await vi.advanceTimersByTimeAsync(10); };
      const regain = async (id: string) => { gate.closed.delete(id); notifyToolGateChange(id); await vi.advanceTimersByTimeAsync(_DEFERRED_POLLING_DELAY_MS_FOR_TESTING + 10); };
      beforeEach(() => { vi.useFakeTimers(); });

      it('one stop, however often the gate moves', async () => {
        await polling('m-loop');
        await lose('m-loop');
        expect(count('m-loop', 'stop polling')).toBe(1);
        notifyToolGateChange('m-loop');
        notifyToolGateChange('m-loop');
        await vi.advanceTimersByTimeAsync(_DEFERRED_POLLING_DELAY_MS_FOR_TESTING + 10);
        expect(count('m-loop', 'stop polling')).toBe(1);
      });

      it('two events at once still send one stop', async () => {
        await polling('m-race');
        gate.closed.add('m-race');
        notifyToolGateChange('m-race');
        notifyToolGateChange('m-race');
        await vi.advanceTimersByTimeAsync(10);
        expect(count('m-race', 'stop polling')).toBe(1);
      });

      it('no start is sent when MCP returns, whatever else moves', async () => {
        const project = await polling('m-return');
        await lose('m-return');
        await regain('m-return');
        notifyToolGateChange('m-return');
        emitAgentMcpConnected('m-return');
        await vi.advanceTimersByTimeAsync(_DEFERRED_POLLING_DELAY_MS_FOR_TESTING + 10);
        expect(count('m-return', 'start polling')).toBe(0);
        expect(listPausedPolling(project.id)).toEqual([{ agentId: 'm-return', agentName: 'looper' }]);
      });

      it('is offered Resume only with MCP back', async () => {
        const project = await polling('m-offer');
        const changed = vi.fn();
        const off = onPollingPauseChanged(changed);
        await lose('m-offer');
        expect(listPausedPolling(project.id)).toEqual([]);
        await regain('m-offer');
        expect(listPausedPolling(project.id)).toHaveLength(1);
        expect(changed).toHaveBeenCalled();
        off();
      });

      it('Resume sends one start to a live same-session member, once', async () => {
        const project = await polling('m-resume');
        await lose('m-resume');
        await regain('m-resume');
        expect(await resumePausedPolling(project.id, 'm-resume')).toBe(true);
        expect(count('m-resume', 'start polling')).toBe(1);
        expect(await resumePausedPolling(project.id, 'm-resume')).toBe(false);
        expect(count('m-resume', 'start polling')).toBe(1);
        expect(listPausedPolling(project.id)).toEqual([]);
      });

      it('two clicks at once send one start', async () => {
        const project = await polling('m-double');
        await lose('m-double');
        await regain('m-double');
        const answers = await Promise.all([resumePausedPolling(project.id, 'm-double'), resumePausedPolling(project.id, 'm-double')]);
        expect(answers.filter(Boolean)).toHaveLength(1);
        expect(count('m-double', 'start polling')).toBe(1);
      });

      it('Resume does nothing while MCP is off again', async () => {
        const project = await polling('m-off-again');
        await lose('m-off-again');
        expect(await resumePausedPolling(project.id, 'm-off-again')).toBe(false);
        expect(count('m-off-again', 'start polling')).toBe(0);
      });

      it('a resumed loop that loses MCP again costs one more stop, and needs Resume again', async () => {
        const project = await polling('m-flips');
        for (let cycle = 1; cycle <= 3; cycle++) {
          await lose('m-flips');
          expect(count('m-flips', 'stop polling')).toBe(cycle);
          await regain('m-flips');
          expect(count('m-flips', 'start polling')).toBe(cycle - 1);
          expect(await resumePausedPolling(project.id, 'm-flips')).toBe(true);
          expect(count('m-flips', 'start polling')).toBe(cycle);
        }
      });

      it('one stop per project it polls, each with its own offer, and a project it doesn\'t poll gets nothing', async () => {
        const first = await polling('m-both', 'First');
        const second = await groupProjectRegistry.create('Second');
        const quiet = await groupProjectRegistry.create('Quiet');
        bindMember(second.id, 'm-both', 'looper');
        bindMember(quiet.id, 'm-both', 'looper');
        await setProjectPolling(second.id, true);
        mockPtyWrite.mockClear();
        await lose('m-both');
        expect(count('m-both', 'stop polling')).toBe(2);
        await regain('m-both');
        expect(listPausedPolling(first.id)).toHaveLength(1);
        expect(listPausedPolling(second.id)).toHaveLength(1);
        expect(listPausedPolling(quiet.id)).toEqual([]);
      });

      it('user-stopped while paused isn\'t offered, and Resume sends nothing', async () => {
        const project = await polling('m-user');
        await lose('m-user');
        await setProjectPolling(project.id, false);
        mockPtyWrite.mockClear();
        await regain('m-user');
        expect(listPausedPolling(project.id)).toEqual([]);
        expect(await resumePausedPolling(project.id, 'm-user')).toBe(false);
        expect(instructions()).toEqual([]);
      });

      it('user-stopped before MCP went off gets no stop and no offer', async () => {
        const project = await polling('m-before');
        await setProjectPolling(project.id, false);
        mockPtyWrite.mockClear();
        await lose('m-before');
        await regain('m-before');
        expect(instructions()).toEqual([]);
        expect(listPausedPolling(project.id)).toEqual([]);
      });

      it('a session with no recent reads reads as ended: no stop and no offer', async () => {
        const project = await polling('m-self');
        await vi.advanceTimersByTimeAsync(POLLING_LIVE_WINDOW_MS + 1);
        mockPtyWrite.mockClear();
        await lose('m-self');
        await regain('m-self');
        expect(instructions()).toEqual([]);
        expect(listPausedPolling(project.id)).toEqual([]);
      });

      it('reads keep a loop live past that window', async () => {
        const project = await polling('m-reads');
        await vi.advanceTimersByTimeAsync(POLLING_LIVE_WINDOW_MS - 1);
        notePollingRead('m-reads', project.id);
        await vi.advanceTimersByTimeAsync(POLLING_LIVE_WINDOW_MS - 1);
        await lose('m-reads');
        expect(count('m-reads', 'stop polling')).toBe(1);
      });

      it('reading the board without being told to poll isn\'t a loop', async () => {
        const project = await groupProjectRegistry.create('Reader');
        start('m-reader');
        bindMember(project.id, 'm-reader', 'reader');
        await groupProjectRegistry.update(project.id, { metadata: { pollingEnabled: true } });
        watchPollingForMcp();
        notePollingRead('m-reader', project.id);
        await lose('m-reader');
        await regain('m-reader');
        expect(instructions()).toEqual([]);
        expect(listPausedPolling(project.id)).toEqual([]);
      });

      it('a stopped agent gets no offer, and Resume neither starts nor wakes it', async () => {
        const project = await polling('m-stopped');
        await lose('m-stopped');
        agentRegistry.untrack('m-stopped');
        mockIsRunning.mockReturnValue(false);
        mockPtyWrite.mockClear();
        await regain('m-stopped');
        expect(listPausedPolling(project.id)).toEqual([]);
        expect(await resumePausedPolling(project.id, 'm-stopped')).toBe(false);
        expect(instructions()).toEqual([]);
        expect(agentRegistry.get('m-stopped')).toBeUndefined();

        start('m-stopped');
        emitAgentMcpConnected('m-stopped');
        await vi.advanceTimersByTimeAsync(_DEFERRED_POLLING_DELAY_MS_FOR_TESTING + 10);
        expect(instructions()).toEqual([]);
        expect(listPausedPolling(project.id)).toEqual([]);
      });

      it('a sleeping member gets no stop, and nothing wakes it', async () => {
        await polling('m-asleep');
        agentRegistry.untrack('m-asleep');
        mockIsRunning.mockReturnValue(false);
        await lose('m-asleep');
        await regain('m-asleep');
        expect(instructions()).toEqual([]);
        expect(agentRegistry.get('m-asleep')).toBeUndefined();
      });

      it('a new session doesn\'t inherit: a restart with no gap ends the offer', async () => {
        const project = await polling('m-new');
        await lose('m-new');
        start('m-new');
        mockPtyWrite.mockClear();
        await regain('m-new');
        expect(listPausedPolling(project.id)).toEqual([]);
        expect(await resumePausedPolling(project.id, 'm-new')).toBe(false);
        expect(instructions()).toEqual([]);
      });

      it('a new session gets no stop for a loop the last one ran', async () => {
        await polling('m-next');
        start('m-next');
        mockPtyWrite.mockClear();
        await lose('m-next');
        expect(instructions()).toEqual([]);
      });

      it('leaving the project while paused ends the offer', async () => {
        const project = await polling('m-left');
        await lose('m-left');
        bindingManager.unbind('m-left', project.id);
        mockPtyWrite.mockClear();
        await regain('m-left');
        expect(await resumePausedPolling(project.id, 'm-left')).toBe(false);
        expect(instructions()).toEqual([]);
      });

      it('a project without polling on gets no message either way', async () => {
        const project = await groupProjectRegistry.create('Quiet');
        start('m-quiet');
        bindMember(project.id, 'm-quiet', 'quiet');
        watchPollingForMcp();
        await lose('m-quiet');
        await regain('m-quiet');
        expect(instructions()).toEqual([]);
      });

      it('a start never delivered still delivers by itself: no loop was stopped, and someone asked', async () => {
        const project = await offMember('m-never');
        await setProjectPolling(project.id, true);
        watchPollingForMcp();
        notifyToolGateChange('m-never');
        await vi.advanceTimersByTimeAsync(10);
        expect(count('m-never', 'stop polling')).toBe(0);
        await regain('m-never');
        expect(count('m-never', 'start polling')).toBe(1);
        expect(listPausedPolling(project.id)).toEqual([]);
      });
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
