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
    CHAT: { RUNTIME_NOTICE: 'chat:runtime-notice' },
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
  portEnv: vi.fn(() => ({ CLUBHOUSE_HOOK_PORT: '9999' })),
  getPort: () => mockGetPort(),
}));

const DISPATCHER_DIR = 'dispatcher-folder';
const mockPathExists = vi.fn((_p: string) => Promise.resolve(false));
vi.mock('./fs-utils', () => ({
  pathExists: (p: string) => mockPathExists(p),
}));
vi.mock('./dispatcher/dispatcher-paths', () => ({
  getDispatcherPath: () => DISPATCHER_DIR,
  getDispatcherFolders: () => [DISPATCHER_DIR, `${DISPATCHER_DIR}-chat`],
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
      expect(mockRestoreForAgent).toHaveBeenCalledWith('agent-a', expect.objectContaining({ onRepairRequired: expect.any(Function) }));
      expect(mockRestoreForAgent).toHaveBeenCalledWith('agent-c', expect.objectContaining({ onRepairRequired: expect.any(Function) }));
      expect(mockRestoreForAgent.mock.calls.map((args) => args[0])).not.toContain('agent-b');
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

      expect(mockStripClubhouseHooksFromFile).toHaveBeenCalledWith('/p/dur-a/.github/hooks/hooks.json', expect.objectContaining({ onRepairRequired: expect.any(Function) }));
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

      expect(mockRestoreForAgent).toHaveBeenCalledWith('dur-a', expect.objectContaining({ onRepairRequired: expect.any(Function) }));
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

      expect(mockStripClubhouseHooksFromFile).toHaveBeenCalledWith('/p/dur-copilot/.github/hooks/hooks.json', expect.objectContaining({ onRepairRequired: expect.any(Function) }));
      expect(mockStripClubhouseHooksFromFile.mock.calls.map((args) => args[0])).not.toContain('/p/dur-claude/.github/hooks/hooks.json');
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

  describe('applyDisabledForOrchestrator — the Dispatcher (#2535)', () => {
    beforeEach(() => {
      mockGetProvider.mockReturnValue({ id: 'copilot-cli', writeHooksConfig: vi.fn() });
      mockIsHookCapable.mockReturnValue(true);
      mockGetHooksConfigPath.mockImplementation((_provider: unknown, cwd: string) => `${cwd}|hooks`);
      mockStripClubhouseHooksFromFile.mockResolvedValue(true);
      mockGetAllRegistrations.mockReturnValue(new Map());
      mockProjectStoreList.mockResolvedValue([]);
    });

    it('strips the stopped Dispatcher in its own folder, which is in no project', async () => {
      mockPathExists.mockResolvedValueOnce(true);
      mockListDurable.mockImplementationOnce((dir: unknown) => Promise.resolve(dir === DISPATCHER_DIR
        ? [{ id: 'disp', name: 'Dispatcher', color: 'indigo', orchestrator: 'copilot-cli' }]
        : []));

      const affected = await applyDisabledForOrchestrator('copilot-cli');

      expect(mockStripClubhouseHooksFromFile).toHaveBeenCalledWith(`${DISPATCHER_DIR}|hooks`, expect.objectContaining({ onRepairRequired: expect.any(Function) }));
      expect(affected).toEqual(['disp']);
    });

    it('skips the Dispatcher folder when it was never created', async () => {
      mockPathExists.mockResolvedValueOnce(false);
      await applyDisabledForOrchestrator('copilot-cli');
      expect(mockListDurable).not.toHaveBeenCalledWith(DISPATCHER_DIR);
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


describe('Copilot terminal-only hook toggles', () => {
  const provider = { id: 'copilot-cli', writeHooksConfig: vi.fn(async () => {}) };
  beforeEach(() => {
    vi.clearAllMocks();
    mockBroadcastToAllWindows.mockReset();
    mockClearForAgent.mockReset();
    mockSnapshotFile.mockReset().mockResolvedValue(undefined);
    mockListDurable.mockReset().mockResolvedValue([]);
    provider.writeHooksConfig.mockReset().mockResolvedValue(undefined);
    mockRestoreForAgent.mockReset().mockResolvedValue(undefined);
    mockStripClubhouseHooksFromFile.mockReset().mockResolvedValue(true);
    mockGetProvider.mockReturnValue(provider);
    mockIsHookCapable.mockReturnValue(true);
    mockGetPort.mockReturnValue(12345);
    mockPathExists.mockResolvedValue(false);
    mockProjectStoreList.mockResolvedValue([]);
    mockGetAllRegistrations.mockReturnValue(new Map());
    mockReadProjectOrchestrator.mockResolvedValue('copilot-cli');
    mockGetHooksConfigPath.mockImplementation((_provider: unknown, cwd: unknown) => `${cwd}/.github/hooks/hooks.json`);
  });
  const registrations = () => new Map([
    ['chat', { projectPath: '/p', cwd: '/p/chat', orchestrator: 'copilot-cli', runtime: 'chat' }],
    ['terminal', { projectPath: '/p', cwd: '/p/terminal', orchestrator: 'copilot-cli', runtime: 'pty' }],
  ]);

  it('does not inject or snapshot terminal callbacks into Copilot chat', async () => {
    mockGetAllRegistrations.mockReturnValue(registrations());
    expect(await applyEnabledForOrchestrator('copilot-cli')).toEqual(['terminal']);
    expect(provider.writeHooksConfig.mock.calls).toEqual([['/p/terminal', 'http://127.0.0.1:12345/hook']]);
    expect(mockSnapshotFile.mock.calls).toEqual([['terminal', '/p/terminal/.github/hooks/hooks.json']]);
  });

  it('leaves chat approvals and MCP snapshots intact and excludes its cwd from stopped reconciliation', async () => {
    const approvals = new Set(['chat', 'terminal']);
    const mcpSnapshots = new Set(['chat', 'terminal']);
    mockClearForAgent.mockImplementation((id: unknown) => { approvals.delete(String(id)); });
    mockRestoreForAgent.mockImplementation(async (...args: unknown[]) => { mcpSnapshots.delete(String(args[0])); });
    mockGetAllRegistrations.mockReturnValue(registrations());
    mockProjectStoreList.mockResolvedValue([{ path: '/p' }]);
    mockListDurable.mockResolvedValue([
      { id: 'same-cwd', orchestrator: 'copilot-cli', worktreePath: '/p/chat' },
      { id: 'stopped', orchestrator: 'copilot-cli', worktreePath: '/p/stopped' },
    ]);
    expect(await applyDisabledForOrchestrator('copilot-cli')).toEqual(['terminal', 'stopped']);
    expect(approvals).toEqual(new Set(['chat']));
    expect(mcpSnapshots).toEqual(new Set(['chat']));
    expect(mockRestoreForAgent.mock.calls.map((args) => args[0])).toEqual(['terminal']);
    expect(mockClearForAgent.mock.calls).toEqual([['terminal']]);
    expect(mockStripClubhouseHooksFromFile.mock.calls.map((args) => args[0])).toEqual(['/p/stopped/.github/hooks/hooks.json']);
  });

  it('keeps existing other-provider chat toggle behavior', async () => {
    mockGetAllRegistrations.mockReturnValue(new Map([
      ['other-chat', { cwd: '/p/other', orchestrator: 'claude-code', runtime: 'chat' }],
    ]));
    expect(await applyEnabledForOrchestrator('claude-code')).toEqual(['other-chat']);
    expect(provider.writeHooksConfig).toHaveBeenCalledWith('/p/other', expect.any(String));
    expect(await applyDisabledForOrchestrator('claude-code')).toEqual(['other-chat']);
    expect(mockRestoreForAgent).toHaveBeenCalledWith('other-chat');
  });

  it.each(['running', 'stopped'] as const)('reports skipped %s cleanup without claiming success', async (kind) => {
    const message = 'Copilot hooks at /p/bad were left unchanged. Review and repair the file, then restart.';
    const fail = async (...args: unknown[]) => {
      (args[1] as { onRepairRequired: (message: string) => void }).onRepairRequired(message);
    };
    if (kind === 'running') {
      mockGetAllRegistrations.mockReturnValue(new Map([
        ['bad', { cwd: '/p/bad', orchestrator: 'copilot-cli', runtime: 'pty' }],
      ]));
      mockRestoreForAgent.mockImplementationOnce(fail);
    } else {
      mockProjectStoreList.mockResolvedValue([{ path: '/p' }]);
      mockListDurable.mockResolvedValue([{ id: 'bad', orchestrator: 'copilot-cli', worktreePath: '/p/bad' }]);
      mockStripClubhouseHooksFromFile.mockImplementationOnce(async (...args: unknown[]) => { await fail(...args); return false; });
    }
    expect(await applyDisabledForOrchestrator('copilot-cli')).toEqual([]);
    expect(mockBroadcastToAllWindows.mock.calls).toEqual([
      ['chat:runtime-notice', 'bad', { level: 'warn', code: 'copilot_hooks_repair', message }],
    ]);
  });

  it('does not claim success when a skipped cleanup notice cannot be delivered', async () => {
    mockGetAllRegistrations.mockReturnValue(new Map([
      ['bad', { cwd: '/p/bad', orchestrator: 'copilot-cli', runtime: 'pty' }],
    ]));
    mockBroadcastToAllWindows.mockImplementation(() => { throw new Error('window closed'); });
    mockRestoreForAgent.mockImplementationOnce(async (...args: unknown[]) => {
      (args[1] as { onRepairRequired: (message: string) => void }).onRepairRequired('Review and repair the file.');
    });
    expect(await applyDisabledForOrchestrator('copilot-cli')).toEqual([]);
    expect(mockBroadcastToAllWindows).toHaveBeenCalledTimes(1);
    expect(mockStripClubhouseHooksFromFile).not.toHaveBeenCalled();
  });

  it('reports a failed enable without announcing a successful injection', async () => {
    mockGetAllRegistrations.mockReturnValue(new Map([
      ['bad', { cwd: '/p/bad', orchestrator: 'copilot-cli', runtime: 'pty' }],
    ]));
    provider.writeHooksConfig.mockRejectedValueOnce(new Error('Review and repair the file, then restart.'));
    expect(await applyEnabledForOrchestrator('copilot-cli')).toEqual([]);
    expect(mockBroadcastToAllWindows).toHaveBeenCalledWith('chat:runtime-notice', 'bad', expect.objectContaining({ code: 'copilot_hooks_repair' }));
    expect(mockBroadcastToAllWindows).not.toHaveBeenCalledWith('hook-server:agents-need-restart', expect.anything());
  });
});
