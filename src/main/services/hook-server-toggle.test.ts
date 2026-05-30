import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./log-service', () => ({
  appLog: vi.fn(),
}));

const mockBroadcastToAllWindows = vi.fn();
vi.mock('../util/ipc-broadcast', () => ({
  broadcastToAllWindows: (...args: unknown[]) => mockBroadcastToAllWindows(...args),
}));

vi.mock('../../shared/ipc-channels', () => ({
  IPC: {
    HOOK_SERVER: {
      AGENTS_NEED_RESTART: 'hook-server:agents-need-restart',
    },
  },
}));

const mockGetAllRegistrations = vi.fn();
vi.mock('./agent-registry', () => ({
  agentRegistry: {
    getAllRegistrations: () => mockGetAllRegistrations(),
  },
}));

const mockGetProvider = vi.fn();
const mockIsHookCapable = vi.fn();
vi.mock('../orchestrators', () => ({
  getProvider: (...args: unknown[]) => mockGetProvider(...args),
  isHookCapable: (...args: unknown[]) => mockIsHookCapable(...args),
}));

const mockSnapshotFile = vi.fn(() => Promise.resolve());
const mockRestoreForAgent = vi.fn(() => Promise.resolve());
const mockGetHooksConfigPath = vi.fn();
vi.mock('./config-pipeline', () => ({
  snapshotFile: (...args: unknown[]) => mockSnapshotFile(...args),
  restoreForAgent: (...args: unknown[]) => mockRestoreForAgent(...args),
  getHooksConfigPath: (...args: unknown[]) => mockGetHooksConfigPath(...args),
}));

const mockListPending = vi.fn(() => []);
const mockReset = vi.fn();
vi.mock('./annex-permission-queue', () => ({
  listPending: () => mockListPending(),
  reset: () => mockReset(),
}));

const mockSetEnabled = vi.fn();
const mockGetPort = vi.fn(() => 12345);
vi.mock('./hook-server', () => ({
  setEnabled: (v: boolean) => mockSetEnabled(v),
  getPort: () => mockGetPort(),
}));

import { applyDisabled, applyEnabled, onHookServerSettingsChanged } from './hook-server-toggle';

describe('hook-server-toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('applyDisabled', () => {
    it('flips the hook server off', async () => {
      mockGetAllRegistrations.mockReturnValue(new Map());
      await applyDisabled();
      expect(mockSetEnabled).toHaveBeenCalledWith(false);
    });

    it('resolves any in-flight permissions before stripping hooks', async () => {
      mockGetAllRegistrations.mockReturnValue(new Map());
      // Two pending permissions in flight
      mockListPending.mockReturnValue([
        { requestId: 'r1', agentId: 'a1', toolName: 'Bash', createdAt: 0, timeoutMs: 110_000 },
        { requestId: 'r2', agentId: 'a2', toolName: 'Edit', createdAt: 0, timeoutMs: 110_000 },
      ] as any);
      await applyDisabled();
      expect(mockReset).toHaveBeenCalledTimes(1);
    });

    it('does not call queue.reset when no permissions are pending', async () => {
      mockGetAllRegistrations.mockReturnValue(new Map());
      mockListPending.mockReturnValue([]);
      await applyDisabled();
      expect(mockReset).not.toHaveBeenCalled();
    });

    it('strips Clubhouse hooks from every running agent and reports their ids', async () => {
      mockGetAllRegistrations.mockReturnValue(new Map([
        ['agent-a', { projectPath: '/p', cwd: '/p/a', orchestrator: 'claude-code', runtime: 'pty' }],
        ['agent-b', { projectPath: '/p', cwd: '/p/b', orchestrator: 'copilot-cli', runtime: 'pty' }],
      ]));
      const affected = await applyDisabled();
      expect(mockRestoreForAgent).toHaveBeenCalledWith('agent-a');
      expect(mockRestoreForAgent).toHaveBeenCalledWith('agent-b');
      expect(affected).toEqual(['agent-a', 'agent-b']);
    });

    it('broadcasts agents-need-restart with the affected agentIds', async () => {
      mockGetAllRegistrations.mockReturnValue(new Map([
        ['agent-a', { projectPath: '/p', cwd: '/p/a', orchestrator: 'claude-code', runtime: 'pty' }],
      ]));
      await applyDisabled();
      expect(mockBroadcastToAllWindows).toHaveBeenCalledWith(
        'hook-server:agents-need-restart',
        { reason: 'disabled', agentIds: ['agent-a'] },
      );
    });

    it('does not broadcast when no agents were affected', async () => {
      mockGetAllRegistrations.mockReturnValue(new Map());
      await applyDisabled();
      expect(mockBroadcastToAllWindows).not.toHaveBeenCalled();
    });

    it('continues processing remaining agents when one strip fails', async () => {
      mockGetAllRegistrations.mockReturnValue(new Map([
        ['agent-a', { projectPath: '/p', cwd: '/p/a', orchestrator: 'claude-code', runtime: 'pty' }],
        ['agent-b', { projectPath: '/p', cwd: '/p/b', orchestrator: 'claude-code', runtime: 'pty' }],
      ]));
      mockRestoreForAgent.mockImplementationOnce(() => Promise.reject(new Error('disk failure')));
      const affected = await applyDisabled();
      // First failed, second succeeded — only the second is reported
      expect(affected).toEqual(['agent-b']);
    });
  });

  describe('applyEnabled', () => {
    const mockProvider = {
      id: 'claude-code',
      writeHooksConfig: vi.fn(() => Promise.resolve()),
    };

    beforeEach(() => {
      mockProvider.writeHooksConfig.mockClear();
      mockGetProvider.mockReturnValue(mockProvider);
      mockIsHookCapable.mockReturnValue(true);
      mockGetHooksConfigPath.mockReturnValue('/p/a/.claude/settings.local.json');
    });

    it('flips the hook server on', async () => {
      mockGetAllRegistrations.mockReturnValue(new Map());
      await applyEnabled();
      expect(mockSetEnabled).toHaveBeenCalledWith(true);
    });

    it('skips re-injection when the server port is 0 (server not started)', async () => {
      mockGetPort.mockReturnValueOnce(0);
      mockGetAllRegistrations.mockReturnValue(new Map([
        ['agent-a', { projectPath: '/p', cwd: '/p/a', orchestrator: 'claude-code', runtime: 'pty' }],
      ]));
      const affected = await applyEnabled();
      expect(affected).toEqual([]);
      expect(mockProvider.writeHooksConfig).not.toHaveBeenCalled();
    });

    it('re-injects hooks for each running agent with a known cwd', async () => {
      mockGetAllRegistrations.mockReturnValue(new Map([
        ['agent-a', { projectPath: '/p', cwd: '/p/a', orchestrator: 'claude-code', runtime: 'pty' }],
        ['agent-b', { projectPath: '/p', cwd: '/p/b', orchestrator: 'claude-code', runtime: 'pty' }],
      ]));
      const affected = await applyEnabled();
      expect(mockProvider.writeHooksConfig).toHaveBeenCalledWith('/p/a', 'http://127.0.0.1:12345/hook');
      expect(mockProvider.writeHooksConfig).toHaveBeenCalledWith('/p/b', 'http://127.0.0.1:12345/hook');
      expect(affected).toEqual(['agent-a', 'agent-b']);
    });

    it('skips agents with unknown cwd (legacy registrations)', async () => {
      mockGetAllRegistrations.mockReturnValue(new Map([
        ['agent-legacy', { projectPath: '/p', orchestrator: 'claude-code', runtime: 'pty' }],
      ]));
      const affected = await applyEnabled();
      expect(mockProvider.writeHooksConfig).not.toHaveBeenCalled();
      expect(affected).toEqual([]);
    });

    it('snapshots the hook config file before re-injecting (so future disable can restore)', async () => {
      mockGetAllRegistrations.mockReturnValue(new Map([
        ['agent-a', { projectPath: '/p', cwd: '/p/a', orchestrator: 'claude-code', runtime: 'pty' }],
      ]));
      await applyEnabled();
      expect(mockSnapshotFile).toHaveBeenCalledWith('agent-a', '/p/a/.claude/settings.local.json');
    });

    it('broadcasts agents-need-restart with the affected agentIds', async () => {
      mockGetAllRegistrations.mockReturnValue(new Map([
        ['agent-a', { projectPath: '/p', cwd: '/p/a', orchestrator: 'claude-code', runtime: 'pty' }],
      ]));
      await applyEnabled();
      expect(mockBroadcastToAllWindows).toHaveBeenCalledWith(
        'hook-server:agents-need-restart',
        { reason: 'enabled', agentIds: ['agent-a'] },
      );
    });

    it('skips providers that are not hook-capable', async () => {
      mockIsHookCapable.mockReturnValue(false);
      mockGetAllRegistrations.mockReturnValue(new Map([
        ['agent-a', { projectPath: '/p', cwd: '/p/a', orchestrator: 'claude-code', runtime: 'pty' }],
      ]));
      const affected = await applyEnabled();
      expect(mockProvider.writeHooksConfig).not.toHaveBeenCalled();
      expect(affected).toEqual([]);
    });
  });

  describe('onHookServerSettingsChanged', () => {
    it('routes enabled=true to applyEnabled', async () => {
      mockGetAllRegistrations.mockReturnValue(new Map());
      await onHookServerSettingsChanged({ enabled: true });
      expect(mockSetEnabled).toHaveBeenCalledWith(true);
    });

    it('routes enabled=false to applyDisabled', async () => {
      mockGetAllRegistrations.mockReturnValue(new Map());
      await onHookServerSettingsChanged({ enabled: false });
      expect(mockSetEnabled).toHaveBeenCalledWith(false);
    });
  });
});
