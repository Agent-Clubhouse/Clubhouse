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
const mockReadProjectOrchestrator = vi.fn(() => Promise.resolve(undefined));
vi.mock('./agent-registry', () => ({
  agentRegistry: {
    getAllRegistrations: () => mockGetAllRegistrations(),
  },
  readProjectOrchestrator: (...args: unknown[]) => mockReadProjectOrchestrator(...args),
  DEFAULT_ORCHESTRATOR: 'claude-code',
}));

const mockProjectStoreList = vi.fn(() => Promise.resolve([]));
vi.mock('./project-store', () => ({
  list: (...args: unknown[]) => mockProjectStoreList(...args),
}));

const mockListDurable = vi.fn(() => Promise.resolve([]));
vi.mock('./agent-config', () => ({
  listDurable: (...args: unknown[]) => mockListDurable(...args),
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
const mockStripClubhouseHooksFromFile = vi.fn(() => Promise.resolve(true));
vi.mock('./config-pipeline', () => ({
  snapshotFile: (...args: unknown[]) => mockSnapshotFile(...args),
  restoreForAgent: (...args: unknown[]) => mockRestoreForAgent(...args),
  getHooksConfigPath: (...args: unknown[]) => mockGetHooksConfigPath(...args),
  stripClubhouseHooksFromFile: (...args: unknown[]) => mockStripClubhouseHooksFromFile(...args),
}));

const mockClearForAgent = vi.fn();
vi.mock('./annex-permission-queue', () => ({
  clearForAgent: (...args: unknown[]) => mockClearForAgent(...args),
}));

const mockGetPort = vi.fn(() => 12345);
vi.mock('./hook-server', () => ({
  getPort: () => mockGetPort(),
}));

import {
  applyDisabledForOrchestrator,
  applyEnabledForOrchestrator,
  onOrchestratorHookServerChanged,
} from './hook-server-toggle';

describe('hook-server-toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('applyDisabledForOrchestrator', () => {
    it('only touches agents belonging to the target orchestrator', async () => {
      mockGetAllRegistrations.mockReturnValue(new Map([
        ['agent-a', { projectPath: '/p', cwd: '/p/a', orchestrator: 'copilot-cli', runtime: 'pty' }],
        ['agent-b', { projectPath: '/p', cwd: '/p/b', orchestrator: 'claude-code', runtime: 'pty' }],
        ['agent-c', { projectPath: '/p', cwd: '/p/c', orchestrator: 'copilot-cli', runtime: 'pty' }],
      ]));
      const affected = await applyDisabledForOrchestrator('copilot-cli');
      expect(affected).toEqual(['agent-a', 'agent-c']);
      expect(mockRestoreForAgent).toHaveBeenCalledWith('agent-a');
      expect(mockRestoreForAgent).toHaveBeenCalledWith('agent-c');
      expect(mockRestoreForAgent).not.toHaveBeenCalledWith('agent-b');
    });

    it('clears in-flight permissions for the target orchestrator\'s agents only', async () => {
      mockGetAllRegistrations.mockReturnValue(new Map([
        ['agent-a', { projectPath: '/p', cwd: '/p/a', orchestrator: 'copilot-cli', runtime: 'pty' }],
        ['agent-b', { projectPath: '/p', cwd: '/p/b', orchestrator: 'claude-code', runtime: 'pty' }],
      ]));
      await applyDisabledForOrchestrator('copilot-cli');
      expect(mockClearForAgent).toHaveBeenCalledWith('agent-a');
      expect(mockClearForAgent).not.toHaveBeenCalledWith('agent-b');
    });

    it('does NOT globally disable the hook server (no setEnabled)', async () => {
      // hook-server mock only exposes getPort — a call to setEnabled would throw.
      mockGetAllRegistrations.mockReturnValue(new Map());
      await expect(applyDisabledForOrchestrator('claude-code')).resolves.toEqual([]);
    });

    it('broadcasts agents-need-restart with the affected agentIds', async () => {
      mockGetAllRegistrations.mockReturnValue(new Map([
        ['agent-a', { projectPath: '/p', cwd: '/p/a', orchestrator: 'claude-code', runtime: 'pty' }],
      ]));
      await applyDisabledForOrchestrator('claude-code');
      expect(mockBroadcastToAllWindows).toHaveBeenCalledWith(
        'hook-server:agents-need-restart',
        { reason: 'disabled', agentIds: ['agent-a'] },
      );
    });

    it('does not broadcast when no agents were affected', async () => {
      mockGetAllRegistrations.mockReturnValue(new Map([
        ['agent-b', { projectPath: '/p', cwd: '/p/b', orchestrator: 'claude-code', runtime: 'pty' }],
      ]));
      await applyDisabledForOrchestrator('copilot-cli');
      expect(mockBroadcastToAllWindows).not.toHaveBeenCalled();
    });

    it('continues processing remaining agents when one strip fails', async () => {
      mockGetAllRegistrations.mockReturnValue(new Map([
        ['agent-a', { projectPath: '/p', cwd: '/p/a', orchestrator: 'claude-code', runtime: 'pty' }],
        ['agent-b', { projectPath: '/p', cwd: '/p/b', orchestrator: 'claude-code', runtime: 'pty' }],
      ]));
      mockRestoreForAgent.mockImplementationOnce(() => Promise.reject(new Error('disk failure')));
      const affected = await applyDisabledForOrchestrator('claude-code');
      expect(affected).toEqual(['agent-b']);
    });
  });

  describe('applyDisabledForOrchestrator — stopped durable agents', () => {
    const hookProvider = { id: 'copilot-cli', writeHooksConfig: vi.fn(() => Promise.resolve()) };

    beforeEach(() => {
      mockGetProvider.mockReturnValue(hookProvider);
      mockIsHookCapable.mockReturnValue(true);
      mockGetHooksConfigPath.mockImplementation(
        (_provider: unknown, cwd: string) => `${cwd}/.github/hooks/hooks.json`,
      );
      mockStripClubhouseHooksFromFile.mockResolvedValue(true);
    });

    it('strips on-disk hooks for a stopped durable agent of the target orchestrator', async () => {
      mockGetAllRegistrations.mockReturnValue(new Map()); // nothing running
      mockProjectStoreList.mockResolvedValue([{ id: 'proj1', name: 'p', path: '/p' }]);
      mockListDurable.mockResolvedValue([
        { id: 'dur-a', name: 'a', color: '#fff', worktreePath: '/p/dur-a', orchestrator: 'copilot-cli' },
      ]);

      const affected = await applyDisabledForOrchestrator('copilot-cli');

      expect(mockStripClubhouseHooksFromFile).toHaveBeenCalledWith('/p/dur-a/.github/hooks/hooks.json');
      expect(affected).toEqual(['dur-a']);
      expect(mockBroadcastToAllWindows).toHaveBeenCalledWith(
        'hook-server:agents-need-restart',
        { reason: 'disabled', agentIds: ['dur-a'] },
      );
    });

    it('skips a durable agent that is currently running (already handled, no double strip)', async () => {
      mockGetAllRegistrations.mockReturnValue(new Map([
        ['dur-a', { projectPath: '/p', cwd: '/p/dur-a', orchestrator: 'copilot-cli', runtime: 'pty' }],
      ]));
      mockProjectStoreList.mockResolvedValue([{ id: 'proj1', name: 'p', path: '/p' }]);
      mockListDurable.mockResolvedValue([
        { id: 'dur-a', name: 'a', color: '#fff', worktreePath: '/p/dur-a', orchestrator: 'copilot-cli' },
      ]);

      const affected = await applyDisabledForOrchestrator('copilot-cli');

      expect(mockRestoreForAgent).toHaveBeenCalledWith('dur-a');
      expect(mockStripClubhouseHooksFromFile).not.toHaveBeenCalled();
      expect(affected).toEqual(['dur-a']);
    });

    it('skips durable agents belonging to a different orchestrator', async () => {
      mockGetAllRegistrations.mockReturnValue(new Map());
      mockProjectStoreList.mockResolvedValue([{ id: 'proj1', name: 'p', path: '/p' }]);
      mockListDurable.mockResolvedValue([
        { id: 'dur-claude', name: 'c', color: '#fff', worktreePath: '/p/dur-claude', orchestrator: 'claude-code' },
        { id: 'dur-copilot', name: 'c', color: '#fff', worktreePath: '/p/dur-copilot', orchestrator: 'copilot-cli' },
      ]);

      const affected = await applyDisabledForOrchestrator('copilot-cli');

      expect(mockStripClubhouseHooksFromFile).toHaveBeenCalledWith('/p/dur-copilot/.github/hooks/hooks.json');
      expect(mockStripClubhouseHooksFromFile).not.toHaveBeenCalledWith('/p/dur-claude/.github/hooks/hooks.json');
      expect(affected).toEqual(['dur-copilot']);
    });

    it('resolves a durable agent with no explicit orchestrator via the project setting', async () => {
      mockGetAllRegistrations.mockReturnValue(new Map());
      mockReadProjectOrchestrator.mockResolvedValueOnce('copilot-cli');
      mockProjectStoreList.mockResolvedValue([{ id: 'proj1', name: 'p', path: '/p' }]);
      mockListDurable.mockResolvedValue([
        { id: 'dur-inherit', name: 'i', color: '#fff', worktreePath: '/p/dur-inherit' },
      ]);

      const affected = await applyDisabledForOrchestrator('copilot-cli');

      expect(affected).toEqual(['dur-inherit']);
    });

    it('does not count a durable agent whose file had no Clubhouse hooks', async () => {
      mockGetAllRegistrations.mockReturnValue(new Map());
      mockStripClubhouseHooksFromFile.mockResolvedValue(false);
      mockProjectStoreList.mockResolvedValue([{ id: 'proj1', name: 'p', path: '/p' }]);
      mockListDurable.mockResolvedValue([
        { id: 'dur-a', name: 'a', color: '#fff', worktreePath: '/p/dur-a', orchestrator: 'copilot-cli' },
      ]);

      const affected = await applyDisabledForOrchestrator('copilot-cli');

      expect(affected).toEqual([]);
      expect(mockBroadcastToAllWindows).not.toHaveBeenCalled();
    });

    it('does not reconcile durable agents for a non-hook-capable orchestrator', async () => {
      mockIsHookCapable.mockReturnValue(false);
      mockGetAllRegistrations.mockReturnValue(new Map());
      mockProjectStoreList.mockResolvedValue([{ id: 'proj1', name: 'p', path: '/p' }]);
      mockListDurable.mockResolvedValue([
        { id: 'dur-a', name: 'a', color: '#fff', worktreePath: '/p/dur-a', orchestrator: 'copilot-cli' },
      ]);

      const affected = await applyDisabledForOrchestrator('copilot-cli');

      expect(mockStripClubhouseHooksFromFile).not.toHaveBeenCalled();
      expect(affected).toEqual([]);
    });

    it('continues when one project fails to list durable agents', async () => {
      mockGetAllRegistrations.mockReturnValue(new Map());
      mockProjectStoreList.mockResolvedValue([
        { id: 'proj1', name: 'p1', path: '/p1' },
        { id: 'proj2', name: 'p2', path: '/p2' },
      ]);
      mockListDurable
        .mockRejectedValueOnce(new Error('corrupt agents.json'))
        .mockResolvedValueOnce([
          { id: 'dur-b', name: 'b', color: '#fff', worktreePath: '/p2/dur-b', orchestrator: 'copilot-cli' },
        ]);

      const affected = await applyDisabledForOrchestrator('copilot-cli');

      expect(affected).toEqual(['dur-b']);
    });
  });

  describe('applyEnabledForOrchestrator', () => {
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

    it('re-injects hooks only for the target orchestrator\'s agents with a known cwd', async () => {
      mockGetAllRegistrations.mockReturnValue(new Map([
        ['agent-a', { projectPath: '/p', cwd: '/p/a', orchestrator: 'claude-code', runtime: 'pty' }],
        ['agent-b', { projectPath: '/p', cwd: '/p/b', orchestrator: 'copilot-cli', runtime: 'pty' }],
      ]));
      const affected = await applyEnabledForOrchestrator('claude-code');
      expect(mockProvider.writeHooksConfig).toHaveBeenCalledWith('/p/a', 'http://127.0.0.1:12345/hook');
      expect(mockProvider.writeHooksConfig).not.toHaveBeenCalledWith('/p/b', expect.anything());
      expect(affected).toEqual(['agent-a']);
    });

    it('returns early for an unknown provider', async () => {
      mockGetProvider.mockReturnValue(undefined);
      mockGetAllRegistrations.mockReturnValue(new Map([
        ['agent-a', { projectPath: '/p', cwd: '/p/a', orchestrator: 'mystery', runtime: 'pty' }],
      ]));
      const affected = await applyEnabledForOrchestrator('mystery');
      expect(affected).toEqual([]);
      expect(mockProvider.writeHooksConfig).not.toHaveBeenCalled();
    });

    it('returns early for a non-hook-capable provider', async () => {
      mockIsHookCapable.mockReturnValue(false);
      mockGetAllRegistrations.mockReturnValue(new Map([
        ['agent-a', { projectPath: '/p', cwd: '/p/a', orchestrator: 'claude-code', runtime: 'pty' }],
      ]));
      const affected = await applyEnabledForOrchestrator('claude-code');
      expect(affected).toEqual([]);
      expect(mockProvider.writeHooksConfig).not.toHaveBeenCalled();
    });

    it('skips re-injection when the server port is 0 (server not started)', async () => {
      mockGetPort.mockReturnValueOnce(0);
      mockGetAllRegistrations.mockReturnValue(new Map([
        ['agent-a', { projectPath: '/p', cwd: '/p/a', orchestrator: 'claude-code', runtime: 'pty' }],
      ]));
      const affected = await applyEnabledForOrchestrator('claude-code');
      expect(affected).toEqual([]);
      expect(mockProvider.writeHooksConfig).not.toHaveBeenCalled();
    });

    it('skips agents with unknown cwd (legacy registrations)', async () => {
      mockGetAllRegistrations.mockReturnValue(new Map([
        ['agent-legacy', { projectPath: '/p', orchestrator: 'claude-code', runtime: 'pty' }],
      ]));
      const affected = await applyEnabledForOrchestrator('claude-code');
      expect(mockProvider.writeHooksConfig).not.toHaveBeenCalled();
      expect(affected).toEqual([]);
    });

    it('snapshots the hook config file before re-injecting (so future disable can restore)', async () => {
      mockGetAllRegistrations.mockReturnValue(new Map([
        ['agent-a', { projectPath: '/p', cwd: '/p/a', orchestrator: 'claude-code', runtime: 'pty' }],
      ]));
      await applyEnabledForOrchestrator('claude-code');
      expect(mockSnapshotFile).toHaveBeenCalledWith('agent-a', '/p/a/.claude/settings.local.json');
    });

    it('broadcasts agents-need-restart with the affected agentIds', async () => {
      mockGetAllRegistrations.mockReturnValue(new Map([
        ['agent-a', { projectPath: '/p', cwd: '/p/a', orchestrator: 'claude-code', runtime: 'pty' }],
      ]));
      await applyEnabledForOrchestrator('claude-code');
      expect(mockBroadcastToAllWindows).toHaveBeenCalledWith(
        'hook-server:agents-need-restart',
        { reason: 'enabled', agentIds: ['agent-a'] },
      );
    });

    it('does not reach into durable configs (stopped agents get hooks via startup injection)', async () => {
      mockGetAllRegistrations.mockReturnValue(new Map([
        ['agent-a', { projectPath: '/p', cwd: '/p/a', orchestrator: 'claude-code', runtime: 'pty' }],
      ]));
      await applyEnabledForOrchestrator('claude-code');
      expect(mockListDurable).not.toHaveBeenCalled();
      expect(mockStripClubhouseHooksFromFile).not.toHaveBeenCalled();
    });
  });

  describe('onOrchestratorHookServerChanged', () => {
    const mockProvider = { id: 'claude-code', writeHooksConfig: vi.fn(() => Promise.resolve()) };

    it('routes enabled=true to applyEnabledForOrchestrator', async () => {
      mockGetProvider.mockReturnValue(mockProvider);
      mockIsHookCapable.mockReturnValue(true);
      mockGetHooksConfigPath.mockReturnValue('/p/a/.claude/settings.local.json');
      mockGetAllRegistrations.mockReturnValue(new Map([
        ['agent-a', { projectPath: '/p', cwd: '/p/a', orchestrator: 'claude-code', runtime: 'pty' }],
      ]));
      await onOrchestratorHookServerChanged('claude-code', true);
      expect(mockProvider.writeHooksConfig).toHaveBeenCalled();
    });

    it('routes enabled=false to applyDisabledForOrchestrator', async () => {
      mockGetAllRegistrations.mockReturnValue(new Map([
        ['agent-a', { projectPath: '/p', cwd: '/p/a', orchestrator: 'claude-code', runtime: 'pty' }],
      ]));
      await onOrchestratorHookServerChanged('claude-code', false);
      expect(mockRestoreForAgent).toHaveBeenCalledWith('agent-a');
    });
  });
});
