import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { notifyMcpEnablementChanged } from '../services/mcp-settings';
import { ATTR } from '../../shared/telemetry/attributes';
import { setProducingRuntime } from '../telemetry/__test-utils__/producing-runtime';
import { errorTypeOf, type Classification, type TelemetryRuntime } from '../telemetry/types';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/clubhouse-test') },
  ipcMain: { handle: vi.fn() },
  dialog: {
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    showSaveDialog: vi.fn(async () => ({ canceled: true })),
  },
  BrowserWindow: {
    getFocusedWindow: vi.fn(() => ({ id: 1 })),
    getAllWindows: vi.fn(() => []),
  },
}));

const configChange = vi.hoisted(() => ({ listener: null as ((projectPath: string) => void) | null }));

vi.mock('../services/agent-config', () => ({
  onAgentConfigChanged: (listener: (projectPath: string) => void) => { configChange.listener = listener; return () => {}; },
  listDurable: vi.fn(() => [{ id: 'a1', name: 'Bot' }]),
  createDurable: vi.fn(async () => ({ id: 'agent-1', name: 'Test' })),
  deleteDurable: vi.fn(),
  renameDurable: vi.fn(),
  updateDurable: vi.fn(),
  saveAgentIcon: vi.fn(() => 'icon-filename.png'),
  readAgentIconData: vi.fn(() => 'data:image/png;base64,abc'),
  removeAgentIcon: vi.fn(),
  getDurableConfig: vi.fn(() => ({ id: 'agent-1', model: 'default' })),
  updateDurableConfig: vi.fn(),
  reorderDurable: vi.fn(),
  getWorktreeStatus: vi.fn(() => ({ clean: true, branch: 'main' })),
  deleteCommitAndPush: vi.fn(() => ({ ok: true })),
  deleteWithCleanupBranch: vi.fn(() => ({ ok: true })),
  deleteSaveAsPatch: vi.fn(() => ({ ok: true, filePath: '/tmp/agent.patch' })),
  deleteForce: vi.fn(() => ({ ok: true })),
  deleteUnregister: vi.fn(() => ({ ok: true })),
  getDisposeChecks: vi.fn(async () => ({ dirty: 0, unpushed: 0, unmerged: 0 })),
  disposeHelper: vi.fn(async () => ({ ok: true, message: 'Disposed' })),
}));

vi.mock('../services/agent-creation', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/agent-creation')>(),
  startDurableCreation: vi.fn(async () => ({ agentId: 'agent-2', config: { id: 'agent-2', name: 'Helper', creation: { state: 'creating' } }, done: Promise.resolve('ready') })),
  cancelDurableCreation: vi.fn(async () => true),
  onDurableCreationEvent: vi.fn(() => () => {}),
}));

vi.mock('../services/annex-server', () => ({
  broadcastSnapshotRefresh: vi.fn(),
}));

vi.mock('../services/agent-system', () => ({
  spawnAgent: vi.fn(async () => {}),
  killAgent: vi.fn(async () => {}),
  resolveOrchestrator: vi.fn(async () => ({
    getModelOptions: vi.fn(() => [{ id: 'default', label: 'Default' }]),
    toolVerb: vi.fn((name: string) => name === 'known' ? 'Editing' : null),
  })),
  checkAvailability: vi.fn(async () => ({ available: true })),
  getAvailableOrchestrators: vi.fn(() => ['claude-code', 'aider']),
  isHeadlessAgent: vi.fn(() => false),
  getRunningAgentIds: vi.fn((ids: string[]) => ids.filter((id) => id === 'running_one')),
  isAgentRunning: vi.fn(() => false),
  resolveProfileEnv: vi.fn(async () => undefined),
}));

vi.mock('../services/agent-runtime', () => ({
  getAgentRuntime: vi.fn(() => undefined),
}));

vi.mock('../services/headless-manager', () => ({
  readTranscript: vi.fn(() => 'transcript text'),
  getTranscriptInfo: vi.fn(async () => ({ totalEvents: 10, fileSizeBytes: 1024 })),
  readTranscriptPage: vi.fn(async () => ({ events: [{ type: 'result' }], totalEvents: 10 })),
  readTranscriptFrom: vi.fn(async () => ({ events: [], cursor: 42, skipped: 0, more: false, reset: false })),
}));

vi.mock('../orchestrators/shared', () => ({
  buildSummaryInstruction: vi.fn(() => 'Summarize the work done.'),
  readQuickSummary: vi.fn(async () => 'Quick summary'),
}));

vi.mock('../services/log-service', () => ({
  appLog: vi.fn(),
}));

vi.mock('../services/persona-application', () => ({
  applyPersonaToAgent: vi.fn(async () => undefined),
}));

vi.mock('../services/materialization-service', () => ({
  refreshClubhouseModeReadme: vi.fn(async () => undefined),
}));

vi.mock('../services/orchestration-policy', () => ({
  getOrchestrationPolicy: vi.fn(async () => ({ orchestrate: true })),
  setOrchestrationPolicy: vi.fn(async () => ({ ok: true, message: 'Saved' })),
  turnOffOrchestration: vi.fn(async () => ({ ok: true, message: 'Kept 1 helper(s)', helperIds: ['h1'] })),
  getHelperSummary: vi.fn(async () => ({ hasHelpers: false, helperIds: [] })),
  resolveHelperLaunchSettings: vi.fn(async () => ({ freeAgentMode: false, level: 'standard', ceiling: 'standard', clamped: false })),
  checkHelperLimitFor: vi.fn(async () => ({ ok: true })),
  withAgentLock: vi.fn(async (_p: string, _id: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../services/helper-index', () => ({
  listHelpersEverywhere: vi.fn(async () => []),
}));

vi.mock('../services/project-store', () => ({
  list: vi.fn(async () => []),
}));

vi.mock('../services/clubhouse-mode-settings', () => ({
  isClubhouseModeEnabled: vi.fn(() => false),
}));

vi.mock('../services/finished-quick-agents-store', () => ({
  hydrateFinishedQuickAgents: vi.fn(() => ({ p: [] })),
  applyFinishedQuickAgentChange: vi.fn(() => true),
  onFinishedQuickAgentsChange: vi.fn(),
}));

vi.mock('../services/dispatcher/dispatcher-service', () => ({
  DISPATCHER_PERSONA: 'dispatcher',
  isDispatcherPath: (p: string) => p === 'dispatcher-folder',
  isDispatcherAgentId: (id: string) => id === 'disp',
}));

import { ipcMain, dialog, BrowserWindow } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { CONFIG_CHANGE_DEBOUNCE_MS, registerAgentHandlers } from './agent-handlers';
import { recordStartRequest, _resetStartRequestsForTesting } from '../services/helper-start-requests';
import * as agentConfig from '../services/agent-config';
import * as agentCreation from '../services/agent-creation';
import * as agentSystem from '../services/agent-system';
import * as headlessManager from '../services/headless-manager';
import { buildSummaryInstruction, readQuickSummary } from '../orchestrators/shared';
import { appLog } from '../services/log-service';
import { refreshClubhouseModeReadme } from '../services/materialization-service';
import { applyPersonaToAgent } from '../services/persona-application';
import * as clubhouseModeSettings from '../services/clubhouse-mode-settings';
import * as orchestrationPolicy from '../services/orchestration-policy';
import { getAgentRuntime } from '../services/agent-runtime';
import { AgentStoppingError } from '../services/agent-runtime/agent-stopping';
import { _resetDisposeRequestsForTesting, recordDisposeRequest } from '../services/helper-dispose-requests';
import { broadcastSnapshotRefresh } from '../services/annex-server';
import { agentRegistry } from '../services/agent-registry';
import * as permissionQueue from '../services/annex-permission-queue';
import * as finishedQuickStore from '../services/finished-quick-agents-store';
import * as helperIndex from '../services/helper-index';
import * as projectStore from '../services/project-store';
import * as os from 'os';
import * as nodePath from 'path';

describe('agent-handlers', () => {
  let handlers: Map<string, (...args: any[]) => any>;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = new Map();
    vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: any) => {
      handlers.set(channel, handler);
    });
    registerAgentHandlers();
  });

  it('registers all agent IPC handlers', () => {
    const expectedChannels = [
      IPC.AGENT.LIST_DURABLE, IPC.AGENT.CREATE_DURABLE, IPC.AGENT.DELETE_DURABLE,
      IPC.AGENT.RENAME_DURABLE, IPC.AGENT.UPDATE_DURABLE,
      IPC.AGENT.PICK_ICON, IPC.AGENT.SAVE_ICON, IPC.AGENT.READ_ICON, IPC.AGENT.REMOVE_ICON,
      IPC.AGENT.GET_DURABLE_CONFIG, IPC.AGENT.UPDATE_DURABLE_CONFIG,
      IPC.AGENT.REORDER_DURABLE, IPC.AGENT.GET_WORKTREE_STATUS,
      IPC.AGENT.DELETE_COMMIT_PUSH, IPC.AGENT.DELETE_CLEANUP_BRANCH,
      IPC.AGENT.DELETE_SAVE_PATCH, IPC.AGENT.DELETE_FORCE, IPC.AGENT.DELETE_UNREGISTER,
      IPC.AGENT.SPAWN_AGENT, IPC.AGENT.KILL_AGENT,
      IPC.AGENT.READ_QUICK_SUMMARY, IPC.AGENT.GET_MODEL_OPTIONS,
      IPC.AGENT.CHECK_ORCHESTRATOR, IPC.AGENT.GET_ORCHESTRATORS,
      IPC.AGENT.GET_TOOL_VERB, IPC.AGENT.GET_SUMMARY_INSTRUCTION,
      IPC.AGENT.READ_TRANSCRIPT, IPC.AGENT.GET_TRANSCRIPT_INFO,
      IPC.AGENT.READ_TRANSCRIPT_PAGE, IPC.AGENT.READ_TRANSCRIPT_FROM, IPC.AGENT.IS_HEADLESS_AGENT,
      IPC.AGENT.GET_RUNNING_STATUSES,
      IPC.AGENT.START_DURABLE_CREATION, IPC.AGENT.CANCEL_DURABLE_CREATION,
      IPC.AGENT.FINISHED_QUICK_HYDRATE, IPC.AGENT.FINISHED_QUICK_APPLY,
    ];
    for (const channel of expectedChannels) {
      expect(handlers.has(channel)).toBe(true);
    }
  });

  // --- CRUD ---

  it('LIST_DURABLE refreshes the CH-mode readme when CH mode is enabled', async () => {
    vi.mocked(clubhouseModeSettings.isClubhouseModeEnabled).mockReturnValue(true);
    const handler = handlers.get(IPC.AGENT.LIST_DURABLE)!;
    await handler({}, '/project');

    expect(refreshClubhouseModeReadme).toHaveBeenCalledWith('/project');
  });

  it('LIST_DURABLE does NOT refresh the CH-mode readme when CH mode is disabled', async () => {
    vi.mocked(clubhouseModeSettings.isClubhouseModeEnabled).mockReturnValue(false);
    const handler = handlers.get(IPC.AGENT.LIST_DURABLE)!;
    await handler({}, '/project');

    expect(refreshClubhouseModeReadme).not.toHaveBeenCalled();
  });

  it('LIST_DURABLE delegates to agentConfig.listDurable', async () => {
    const handler = handlers.get(IPC.AGENT.LIST_DURABLE)!;
    const result = await handler({}, '/project');
    expect(agentConfig.listDurable).toHaveBeenCalledWith('/project');
    expect(result).toEqual([{ id: 'a1', name: 'Bot' }]);
  });

  it('GET_RUNNING_STATUSES delegates to agentSystem.getRunningAgentIds', async () => {
    const handler = handlers.get(IPC.AGENT.GET_RUNNING_STATUSES)!;
    const result = await handler({}, ['running_one', 'sleeping_two']);
    expect(agentSystem.getRunningAgentIds).toHaveBeenCalledWith(['running_one', 'sleeping_two']);
    expect(result).toEqual(['running_one']);
  });

  it('CREATE_DURABLE delegates to agentConfig.createDurable', async () => {
    const handler = handlers.get(IPC.AGENT.CREATE_DURABLE)!;
    const result = await handler({}, '/project', 'Bot', '#ff0000', 'gpt-5', true, 'claude-code', false, undefined, undefined, undefined);
    expect(agentConfig.createDurable).toHaveBeenCalledWith('/project', 'Bot', '#ff0000', 'gpt-5', true, 'claude-code', false, undefined, undefined, undefined, undefined);
    expect(result).toEqual({ id: 'agent-1', name: 'Test' });
  });

  it('CREATE_DURABLE refuses a worktree agent name that is not a safe folder/branch name (#2221)', async () => {
    vi.mocked(agentConfig.createDurable).mockClear();
    const handler = handlers.get(IPC.AGENT.CREATE_DURABLE)!;
    await expect(handler({}, '/project', 'x;rm -rf ~', '#ff0000', undefined, true)).rejects.toThrow('Use only letters, digits, - and _ in the agent name.');
    await expect(handler({}, '/project', '-x', '#ff0000')).rejects.toThrow('Start the agent name with a letter, digit or _.');
    expect(agentConfig.createDurable).not.toHaveBeenCalled();
  });

  it('CREATE_DURABLE lets a non-worktree agent keep a free-form display name', async () => {
    const handler = handlers.get(IPC.AGENT.CREATE_DURABLE)!;
    await handler({}, '/project', 'My Bot', '#ff0000', undefined, false);
    expect(agentConfig.createDurable).toHaveBeenCalledWith('/project', 'My Bot', '#ff0000', undefined, false, undefined, undefined, undefined, undefined, undefined, undefined);
  });

  it('CREATE_DURABLE passes folder, branch and branch-from options through (#2226)', async () => {
    const handler = handlers.get(IPC.AGENT.CREATE_DURABLE)!;
    await handler({}, '/project', 'Helper one', '#ff0000', undefined, true, undefined, undefined, undefined, undefined, undefined,
      { folderName: 'helper-1', branchName: 'helper-1/work', branchFrom: 'orch/standby', extra: 'ignored' });
    expect(agentConfig.createDurable).toHaveBeenCalledWith('/project', 'Helper one', '#ff0000', undefined, true, undefined, undefined, undefined, undefined, undefined,
      { folderName: 'helper-1', branchName: 'helper-1/work', branchFrom: 'orch/standby' });
  });

  describe('START_DURABLE_CREATION (#2226)', () => {
    it('returns the id and creating config without the done promise', async () => {
      const handler = handlers.get(IPC.AGENT.START_DURABLE_CREATION)!;
      const result = await handler({}, '/project', { name: 'Helper', color: 'indigo', folderName: 'helper-1', branchFrom: 'main', model: 'default' });
      expect(result).toEqual({ agentId: 'agent-2', config: { id: 'agent-2', name: 'Helper', creation: { state: 'creating' } } });
      expect(agentCreation.startDurableCreation).toHaveBeenCalledWith(
        '/project',
        expect.objectContaining({ name: 'Helper', color: 'indigo', folderName: 'helper-1', branchFrom: 'main' }),
        expect.objectContaining({ inject: undefined }),
      );
      const params = vi.mocked(agentCreation.startDurableCreation).mock.calls[0][1];
      expect(params).not.toHaveProperty('model');
    });

    it('passes a persona injection when a persona is given', async () => {
      const handler = handlers.get(IPC.AGENT.START_DURABLE_CREATION)!;
      await handler({}, '/project', { name: 'Helper', color: 'indigo', persona: 'qa' });
      const opts = vi.mocked(agentCreation.startDurableCreation).mock.calls[0][2];
      expect(typeof opts?.inject).toBe('function');
    });

    it.each([
      [{ color: 'indigo' }, /params.name/],
      [{ name: 'a', color: 3 }, /params.color/],
      [{ name: 'a', color: 'indigo', branchFrom: 7 }, /params.branchFrom/],
      [{ name: 'a', color: 'indigo', mcpIds: [1] }, /params.mcpIds/],
      [{ name: 'a', color: 'indigo', useWorktree: 'yes' }, /params.useWorktree/],
    ])('refuses malformed params %j', async (params, message) => {
      const handler = handlers.get(IPC.AGENT.START_DURABLE_CREATION)!;
      await expect(handler({}, '/project', params)).rejects.toThrow(message);
      expect(agentCreation.startDurableCreation).not.toHaveBeenCalled();
    });

    it('CANCEL_DURABLE_CREATION delegates to cancelDurableCreation', async () => {
      const handler = handlers.get(IPC.AGENT.CANCEL_DURABLE_CREATION)!;
      expect(await handler({}, '/project', 'agent-2')).toBe(true);
      expect(agentCreation.cancelDurableCreation).toHaveBeenCalledWith('/project', 'agent-2');
    });
  });

  describe('Dispatcher singleton guards (#2535)', () => {
    const deletes = [
      IPC.AGENT.DELETE_DURABLE, IPC.AGENT.DELETE_COMMIT_PUSH, IPC.AGENT.DELETE_CLEANUP_BRANCH,
      IPC.AGENT.DELETE_SAVE_PATCH, IPC.AGENT.DELETE_FORCE, IPC.AGENT.DELETE_UNREGISTER,
    ];

    it.each(deletes)('%s refuses the Dispatcher by id or by folder', async (channel) => {
      await expect(handlers.get(channel)!({}, 'dispatcher-folder', 'any')).rejects.toThrow("The Dispatcher can't be deleted.");
      await expect(handlers.get(channel)!({}, 'project', 'disp')).rejects.toThrow("The Dispatcher can't be deleted.");
      expect(agentConfig.deleteDurable).not.toHaveBeenCalled();
    });

    it('refuses orchestration changes', async () => {
      await expect(handlers.get(IPC.AGENT.SET_ORCHESTRATION_POLICY)!({}, 'dispatcher-folder', 'disp', { orchestrate: true })).rejects.toThrow(/orchestration/);
      await expect(handlers.get(IPC.AGENT.TURN_OFF_ORCHESTRATION)!({}, 'dispatcher-folder', 'disp', 'keep')).rejects.toThrow(/orchestration/);
      expect(orchestrationPolicy.setOrchestrationPolicy).not.toHaveBeenCalled();
      expect(orchestrationPolicy.turnOffOrchestration).not.toHaveBeenCalled();
    });

    // The persona rules run in agentConfig.assertPersonaAllowed (#2551); see agent-config.test.
    it('refuses a duplicate in its folder', async () => {
      const start = handlers.get(IPC.AGENT.START_DURABLE_CREATION)!;
      await expect(start({}, 'dispatcher-folder', { name: 'copy', color: 'indigo' })).rejects.toThrow(/duplicated/);
      const create = handlers.get(IPC.AGENT.CREATE_DURABLE)!;
      await expect(create({}, 'dispatcher-folder', 'copy', 'indigo')).rejects.toThrow(/duplicated/);
      expect(agentCreation.startDurableCreation).not.toHaveBeenCalled();
      expect(agentConfig.createDurable).not.toHaveBeenCalled();
    });

    it('allows CLI, model, runtime, auto-sleep and access', async () => {
      const update = handlers.get(IPC.AGENT.UPDATE_DURABLE_CONFIG)!;
      const allowed = { orchestrator: 'codex-cli', model: 'gpt-5', runtimeMode: 'terminal', idleSleep: 30, freeAgentMode: false };
      await update({}, 'dispatcher-folder', 'disp', allowed);
      expect(agentConfig.updateDurableConfig).toHaveBeenCalledWith('dispatcher-folder', 'disp', allowed);
    });
  });

  it('DELETE_DURABLE delegates to agentConfig.deleteDurable', async () => {
    const handler = handlers.get(IPC.AGENT.DELETE_DURABLE)!;
    await handler({}, '/project', 'agent-1');
    expect(agentConfig.deleteDurable).toHaveBeenCalledWith('/project', 'agent-1');
  });

  describe('create and delete telemetry', () => {
    type Flow = { name: string; attrs: unknown[]; outcome?: Classification; thrown?: unknown };
    let flows: Flow[];
    beforeEach(() => {
      flows = [];
      setProducingRuntime({
        level: 'standard',
        flow: (name: string, opts: { attrs?: unknown[] }, fn: () => unknown, extras?: { classify?: (r: unknown) => Classification }) => {
          const f: Flow = { name, attrs: [...(opts.attrs ?? [])] };
          flows.push(f);
          return Promise.resolve(fn()).then(
            (r) => { f.outcome = extras?.classify ? extras.classify(r) : 'ok'; return r; },
            (err) => { f.thrown = err; throw err; },
          );
        },
        step: (_n: string, fn: (s: unknown) => unknown) => fn({ set: () => {} }),
        count: vi.fn(),
      } as unknown as TelemetryRuntime);
    });
    afterEach(() => setProducingRuntime(null));

    it('classifies deletes by result and mode', async () => {
      vi.mocked(agentConfig.deleteForce).mockResolvedValueOnce({ ok: false, message: 'dirty worktree' });
      await handlers.get(IPC.AGENT.DELETE_FORCE)!({}, '/project', 'agent-1');
      await handlers.get(IPC.AGENT.DELETE_UNREGISTER)!({}, '/project', 'agent-1');
      expect(flows).toEqual([
        { name: 'clubhouse.agent.delete', attrs: [ATTR.deleteMode('force')], outcome: { error: 'delete_failed' } },
        { name: 'clubhouse.agent.delete', attrs: [ATTR.deleteMode('unregister')], outcome: 'ok' },
      ]);
    });

    it('rethrows the identical error from create and delete, typed for telemetry', async () => {
      const createErr = new Error('disk full');
      const deleteErr = new Error('locked');
      vi.mocked(agentConfig.createDurable).mockRejectedValueOnce(createErr);
      vi.mocked(agentConfig.deleteDurable).mockRejectedValueOnce(deleteErr);
      await expect(handlers.get(IPC.AGENT.CREATE_DURABLE)!({}, '/project', 'Bot', '#fff')).rejects.toBe(createErr);
      await expect(handlers.get(IPC.AGENT.DELETE_DURABLE)!({}, '/project', 'agent-1')).rejects.toBe(deleteErr);
      expect(flows.map((f) => f.name)).toEqual(['clubhouse.agent.create', 'clubhouse.agent.delete']);
      expect(errorTypeOf(createErr)).toBe('write_failed');
      expect(errorTypeOf(deleteErr)).toBe('delete_failed');
    });
  });

  it('RENAME_DURABLE delegates to agentConfig.renameDurable', async () => {
    const handler = handlers.get(IPC.AGENT.RENAME_DURABLE)!;
    await handler({}, '/project', 'agent-1', 'NewName');
    expect(agentConfig.renameDurable).toHaveBeenCalledWith('/project', 'agent-1', 'NewName');
  });

  it('UPDATE_DURABLE delegates to agentConfig.updateDurable', async () => {
    const handler = handlers.get(IPC.AGENT.UPDATE_DURABLE)!;
    await handler({}, '/project', 'agent-1', { name: 'Updated', color: '#00ff00' });
    expect(agentConfig.updateDurable).toHaveBeenCalledWith('/project', 'agent-1', { name: 'Updated', color: '#00ff00' });
  });

  it('GET_DURABLE_CONFIG delegates to agentConfig.getDurableConfig', async () => {
    const handler = handlers.get(IPC.AGENT.GET_DURABLE_CONFIG)!;
    const result = await handler({}, '/project', 'agent-1');
    expect(agentConfig.getDurableConfig).toHaveBeenCalledWith('/project', 'agent-1');
    expect(result).toEqual({ id: 'agent-1', model: 'default' });
  });

  it('UPDATE_DURABLE_CONFIG delegates to agentConfig.updateDurableConfig', async () => {
    const handler = handlers.get(IPC.AGENT.UPDATE_DURABLE_CONFIG)!;
    await handler({}, '/project', 'agent-1', { model: 'opus' });
    expect(agentConfig.updateDurableConfig).toHaveBeenCalledWith('/project', 'agent-1', { model: 'opus' });
  });

  describe('LIST_HELPERS across projects (#2514)', () => {
    const home = nodePath.join(os.tmpdir(), 'home');
    const other = nodePath.join(os.tmpdir(), 'annex');
    const removed = nodePath.join(os.tmpdir(), 'removed');
    const helper = (id: string) => ({ id, name: id, color: 'teal', createdAt: 'x', parentAgentId: 'lead' });

    it('returns helpers from every project through the helper index, each with its project id', async () => {
      vi.mocked(helperIndex.listHelpersEverywhere).mockResolvedValueOnce([
        { projectPath: home, config: helper('h1') },
        { projectPath: other, config: { ...helper('x1'), parentProjectPath: home } },
        { projectPath: removed, config: helper('x2') },
      ]);
      vi.mocked(projectStore.list).mockResolvedValueOnce([
        { id: 'p-home', name: 'home', path: home }, { id: 'p-annex', name: 'annex', path: other },
      ]);
      const result = await handlers.get(IPC.AGENT.LIST_HELPERS)!({}, home, 'lead', true, false);
      expect(helperIndex.listHelpersEverywhere).toHaveBeenCalledWith(home, 'lead', { recursive: true, includeDisposed: false });
      expect(result).toEqual([
        { projectId: 'p-home', projectPath: home, config: helper('h1') },
        { projectId: 'p-annex', projectPath: other, config: { ...helper('x1'), parentProjectPath: home } },
        { projectId: undefined, projectPath: removed, config: helper('x2') },
      ]);
    });

    it('passes includeDisposed through and skips the project list when there are none', async () => {
      const result = await handlers.get(IPC.AGENT.LIST_HELPERS)!({}, home, 'lead', undefined, true);
      expect(result).toEqual([]);
      expect(helperIndex.listHelpersEverywhere).toHaveBeenCalledWith(home, 'lead', { recursive: undefined, includeDisposed: true });
      expect(projectStore.list).not.toHaveBeenCalled();
    });
  });

  describe('disposing helpers from the UI (#2232)', () => {
    const helper = { id: 'h1', name: 'impl-ipc', parentAgentId: 'agent-1' };
    const clean = { dirty: 0, unpushed: 0, unmerged: 0 };
    let order: string[];

    beforeEach(() => {
      order = [];
      vi.mocked(agentConfig.getDurableConfig).mockResolvedValue(helper as never);
      vi.mocked(agentConfig.getDisposeChecks).mockImplementation(async () => { order.push('check'); return clean; });
      vi.mocked(agentSystem.killAgent).mockImplementation(async () => { order.push('kill'); });
      vi.mocked(agentConfig.disposeHelper).mockImplementation(async () => { order.push('dispose'); return { ok: true, message: 'Disposed', checks: clean }; });
      vi.mocked(agentSystem.isAgentRunning).mockReturnValue(false);
    });

    const dispose = (...args: unknown[]) => handlers.get(IPC.AGENT.DISPOSE_HELPER)!({}, '/project', 'h1', ...args);

    it('returns the dispose checks', async () => {
      const result = await handlers.get(IPC.AGENT.GET_DISPOSE_CHECKS)!({}, '/project', 'h1');
      expect(agentConfig.getDisposeChecks).toHaveBeenCalledWith('/project', 'h1');
      expect(result).toEqual(clean);
    });

    it('checks, then disposes a helper main has asleep, under the orchestrator\'s lock', async () => {
      const result = await dispose();
      expect(order).toEqual(['check', 'dispose']);
      expect(orchestrationPolicy.withAgentLock).toHaveBeenCalledWith('/project', 'agent-1', expect.any(Function));
      expect(agentConfig.disposeHelper).toHaveBeenCalledWith('/project', 'h1', { force: false, expectedParentId: 'agent-1' });
      expect(agentSystem.killAgent).not.toHaveBeenCalled();
      expect(result.ok).toBe(true);
      expect(broadcastSnapshotRefresh).toHaveBeenCalled();
    });

    it('stops a helper main has running and waits for the exit, then checks again before disposing', async () => {
      vi.mocked(agentSystem.isAgentRunning).mockReturnValue(true);
      const result = await dispose();
      expect(order).toEqual(['check', 'kill', 'check', 'dispose']);
      expect(agentSystem.killAgent).toHaveBeenCalledWith('h1', '/project', undefined, 'user', { waitForExit: true });
      expect(result).toMatchObject({ ok: true, stopped: true });
    });

    it('refuses a check that couldn\'t run, even with force, without stopping anything', async () => {
      vi.mocked(agentSystem.isAgentRunning).mockReturnValue(true);
      vi.mocked(agentConfig.getDisposeChecks).mockResolvedValue({ dirty: 0, unpushed: 0, unmerged: null, error: 'its remote has never been fetched' });
      const result = await dispose(true);
      expect(result.ok).toBe(false);
      expect(result.message).toContain('its remote has never been fetched');
      expect(agentSystem.killAgent).not.toHaveBeenCalled();
      expect(agentConfig.disposeHelper).not.toHaveBeenCalled();
    });

    it('refuses work at risk without force, without stopping anything', async () => {
      vi.mocked(agentSystem.isAgentRunning).mockReturnValue(true);
      vi.mocked(agentConfig.getDisposeChecks).mockResolvedValue({ dirty: 2, unpushed: 0, unmerged: 0 });
      const result = await dispose();
      expect(result).toMatchObject({ ok: false, checks: { dirty: 2 } });
      expect(result.changed).toBeUndefined();
      expect(agentSystem.killAgent).not.toHaveBeenCalled();
      expect(agentConfig.disposeHelper).not.toHaveBeenCalled();
    });

    it('forces past the work the user saw', async () => {
      vi.mocked(agentConfig.getDisposeChecks).mockResolvedValue({ dirty: 2, unpushed: 1, unmerged: 0 });
      const result = await dispose(true, { dirty: 2, unpushed: 1, unmerged: 0 });
      expect(result.ok).toBe(true);
      expect(agentConfig.disposeHelper).toHaveBeenCalledWith('/project', 'h1', { force: true, expectedParentId: 'agent-1' });
    });

    it('asks again when there is more at risk than the user saw, before stopping', async () => {
      vi.mocked(agentSystem.isAgentRunning).mockReturnValue(true);
      vi.mocked(agentConfig.getDisposeChecks).mockResolvedValue({ dirty: 4, unpushed: 1, unmerged: 0 });
      const result = await dispose(true, { dirty: 2, unpushed: 1, unmerged: 0 });
      expect(result).toMatchObject({ ok: false, changed: true, checks: { dirty: 4 } });
      expect(agentSystem.killAgent).not.toHaveBeenCalled();
      expect(agentConfig.disposeHelper).not.toHaveBeenCalled();
    });

    it('asks again when the helper saved more work while it stopped', async () => {
      vi.mocked(agentSystem.isAgentRunning).mockReturnValue(true);
      let calls = 0;
      vi.mocked(agentConfig.getDisposeChecks).mockImplementation(async () => (++calls === 1
        ? { dirty: 1, unpushed: 0, unmerged: 0 }
        : { dirty: 1, unpushed: 3, unmerged: 3 }));
      const result = await dispose(true, { dirty: 1, unpushed: 0, unmerged: 0 });
      expect(result).toMatchObject({ ok: false, changed: true, stopped: true, checks: { unpushed: 3 } });
      expect(agentConfig.disposeHelper).not.toHaveBeenCalled();
      expect(broadcastSnapshotRefresh).not.toHaveBeenCalled();
    });

    it('rejects a malformed seen argument', async () => {
      await expect(async () => dispose(true, { dirty: 'lots' })).rejects.toThrow(/whole-number/);
    });

    it('refuses an agent that isn\'t a helper', async () => {
      vi.mocked(agentConfig.getDurableConfig).mockResolvedValue({ id: 'a1', name: 'lead' } as never);
      const result = await dispose();
      expect(result).toEqual({ ok: false, message: 'lead isn\'t a helper' });
      expect(agentConfig.getDisposeChecks).not.toHaveBeenCalled();
    });

    it('removes a disposed row and refuses a live one', async () => {
      vi.mocked(agentConfig.getDurableConfig).mockResolvedValueOnce({ ...helper, disposedAt: '2026-10-18T10:00:00Z' } as never);
      const removed = await handlers.get(IPC.AGENT.REMOVE_DISPOSED)!({}, '/project', 'h1');
      expect(agentConfig.deleteUnregister).toHaveBeenCalledWith('/project', 'h1');
      expect(removed.ok).toBe(true);

      vi.mocked(agentConfig.deleteUnregister).mockClear();
      const refused = await handlers.get(IPC.AGENT.REMOVE_DISPOSED)!({}, '/project', 'h1');
      expect(refused).toEqual({ ok: false, message: 'impl-ipc isn\'t disposed' });
      expect(agentConfig.deleteUnregister).not.toHaveBeenCalled();
    });

    describe('answering a held helper start (#2234)', () => {
      const approve = (...args: unknown[]) => handlers.get(IPC.AGENT.APPROVE_HELPER_START)!({}, ...args);
      const decline = (...args: unknown[]) => handlers.get(IPC.AGENT.DECLINE_HELPER_START)!({}, ...args);
      let sendMessage: ReturnType<typeof vi.fn>;

      beforeEach(() => {
        _resetStartRequestsForTesting();
        sendMessage = vi.fn(async () => {});
        vi.mocked(getAgentRuntime).mockReturnValue({ kind: 'chat', isRunning: () => true, getState: () => 'idle', sendMessage } as never);
      });

      it('validates the arguments in main', async () => {
        await expect(async () => approve('/project', 42)).rejects.toThrow();
        await expect(async () => decline(undefined, 'hstart_1')).rejects.toThrow();
      });

      it('refuses an unknown request', async () => {
        expect(await approve('/project', 'hstart_nope')).toMatchObject({ ok: false });
        expect(sendMessage).not.toHaveBeenCalled();
      });

      it('declines once, telling the orchestrator from main\'s stored data', async () => {
        const recorded = recordStartRequest('/project', 'agent-1', 'lead', { name: 'impl-api', task: 'Build it' });
        if (!recorded.ok) throw new Error('unexpected refusal');
        const id = recorded.request.requestId;
        expect(await decline('/project', id)).toEqual({ ok: true, message: 'Declined' });
        expect(sendMessage).toHaveBeenCalledWith(
          `[Clubhouse] The user declined your request to start helper "impl-api" (request ${id}). Nothing was created.`,
          expect.objectContaining({ source: 'mcp' }),
        );
        expect(await decline('/project', id)).toMatchObject({ ok: false });
        expect(await approve('/project', id)).toMatchObject({ ok: false });
      });

      it('lists the waiting requests', async () => {
        recordStartRequest('/project', 'agent-1', 'lead', { name: 'impl-api', task: 'Build it' });
        const list = await handlers.get(IPC.AGENT.LIST_HELPER_START_REQUESTS)!({});
        expect(list).toEqual([expect.objectContaining({ orchestratorId: 'agent-1', args: { name: 'impl-api', task: 'Build it' } })]);
      });
    });

    describe('reporting the user\'s dispose decision', () => {
      const report = (...args: unknown[]) => handlers.get(IPC.AGENT.REPORT_DISPOSE_DECISION)!({}, ...args);
      let sendMessage: ReturnType<typeof vi.fn>;

      beforeEach(() => {
        _resetDisposeRequestsForTesting();
        sendMessage = vi.fn(async () => {});
        vi.mocked(getAgentRuntime).mockReturnValue({ kind: 'chat', isRunning: () => true, getState: () => 'idle', sendMessage } as never);
      });

      it('reports once to the parent main sent the request for, using the stored name', async () => {
        recordDisposeRequest('/project', 'h1', 'agent-1');
        const first = await report('/project', 'h1', 'declined');
        expect(first).toEqual({ ok: true, delivered: true, message: 'Reported' });
        expect(getAgentRuntime).toHaveBeenCalledWith('agent-1');
        expect(sendMessage).toHaveBeenCalledWith(
          '[Clubhouse] The user declined your request to dispose of impl-ipc. Nothing was changed.',
          expect.objectContaining({ source: 'mcp' }),
        );
        // Used up: a second report for the same request is refused.
        const second = await report('/project', 'h1', 'disposed');
        expect(second).toMatchObject({ ok: false, delivered: false });
        expect(sendMessage).toHaveBeenCalledTimes(1);
      });

      it('refuses without a pending request', async () => {
        const result = await report('/project', 'h1', 'disposed');
        expect(result).toEqual({ ok: false, delivered: false, message: 'No dispose request for impl-ipc is waiting on the user' });
        expect(sendMessage).not.toHaveBeenCalled();
      });

      it('refuses a request recorded for another orchestrator', async () => {
        recordDisposeRequest('/project', 'h1', 'someone-else');
        expect(await report('/project', 'h1', 'declined')).toMatchObject({ ok: false });
        expect(sendMessage).not.toHaveBeenCalled();
      });

      it('refuses a non-helper', async () => {
        vi.mocked(agentConfig.getDurableConfig).mockResolvedValue({ id: 'a1', name: 'lead' } as never);
        recordDisposeRequest('/project', 'a1', 'agent-1');
        expect(await report('/project', 'a1', 'declined')).toEqual({ ok: false, delivered: false, message: 'lead isn\'t a helper' });
        expect(sendMessage).not.toHaveBeenCalled();
      });

      it('uses up the request even when the orchestrator isn\'t running', async () => {
        vi.mocked(getAgentRuntime).mockReturnValue(undefined);
        recordDisposeRequest('/project', 'h1', 'agent-1');
        expect(await report('/project', 'h1', 'disposed')).toMatchObject({ ok: true, delivered: false });
        expect(await report('/project', 'h1', 'disposed')).toMatchObject({ ok: false });
      });

      it('reports no delivery when the orchestrator is shutting down', async () => {
        sendMessage.mockRejectedValue(new AgentStoppingError('agent-1'));
        recordDisposeRequest('/project', 'h1', 'agent-1');
        expect(await report('/project', 'h1', 'disposed')).toEqual({
          ok: true, delivered: false, message: 'The orchestrator is shutting down, so it was not told.',
        });
      });

      it('rejects an unknown decision', async () => {
        await expect(report('/project', 'h1', 'maybe')).rejects.toThrow(/Unknown decision/);
      });
    });
  });

  describe('orchestration policy (#2228)', () => {
    it('reads, sets and queries through the policy service', async () => {
      await handlers.get(IPC.AGENT.GET_ORCHESTRATION_POLICY)!({}, '/project', 'agent-1');
      expect(orchestrationPolicy.getOrchestrationPolicy).toHaveBeenCalledWith('/project', 'agent-1');
      await handlers.get(IPC.AGENT.SET_ORCHESTRATION_POLICY)!({}, '/project', 'agent-1', { orchestrate: true });
      expect(orchestrationPolicy.setOrchestrationPolicy).toHaveBeenCalledWith('/project', 'agent-1', { orchestrate: true });
      expect(broadcastSnapshotRefresh).toHaveBeenCalled();
      await handlers.get(IPC.AGENT.GET_HELPER_SUMMARY)!({}, '/project', 'agent-1');
      expect(orchestrationPolicy.getHelperSummary).toHaveBeenCalledWith('/project', 'agent-1');
      await handlers.get(IPC.AGENT.RESOLVE_HELPER_ACCESS)!({}, '/project', 'agent-1', 'copilot-cli');
      expect(orchestrationPolicy.resolveHelperLaunchSettings).toHaveBeenCalledWith('/project', 'agent-1', { helperProvider: 'copilot-cli' });
      await handlers.get(IPC.AGENT.CHECK_HELPER_LIMIT)!({}, '/project', 'agent-1');
      expect(orchestrationPolicy.checkHelperLimitFor).toHaveBeenCalledWith('/project', 'agent-1');
    });

    it('turns orchestration off with a helper choice', async () => {
      const result = await handlers.get(IPC.AGENT.TURN_OFF_ORCHESTRATION)!({}, '/project', 'agent-1', 'dispose', true);
      expect(orchestrationPolicy.turnOffOrchestration).toHaveBeenCalledWith('/project', 'agent-1', 'dispose', { force: true });
      expect(result.ok).toBe(true);
      expect(broadcastSnapshotRefresh).toHaveBeenCalled();
    });

    it('rejects an unknown turn-off choice', async () => {
      await expect(handlers.get(IPC.AGENT.TURN_OFF_ORCHESTRATION)!({}, '/project', 'agent-1', 'maybe')).rejects.toThrow(/Unknown choice/);
      expect(orchestrationPolicy.turnOffOrchestration).not.toHaveBeenCalled();
    });
  });

  it('REORDER_DURABLE delegates to agentConfig.reorderDurable and broadcasts snapshot', async () => {
    const handler = handlers.get(IPC.AGENT.REORDER_DURABLE)!;
    await handler({}, '/project', ['a2', 'a1', 'a3']);
    expect(agentConfig.reorderDurable).toHaveBeenCalledWith('/project', ['a2', 'a1', 'a3']);
    const { broadcastSnapshotRefresh } = await import('../services/annex-server');
    expect(broadcastSnapshotRefresh).toHaveBeenCalled();
  });

  // --- Icons ---

  it('PICK_ICON returns null when no focused window', async () => {
    vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValueOnce(null);
    const handler = handlers.get(IPC.AGENT.PICK_ICON)!;
    const result = await handler({});
    expect(result).toBeNull();
  });

  it('PICK_ICON returns null when dialog is canceled', async () => {
    const handler = handlers.get(IPC.AGENT.PICK_ICON)!;
    const result = await handler({});
    expect(result).toBeNull();
  });

  it('SAVE_ICON delegates to agentConfig.saveAgentIcon', async () => {
    const handler = handlers.get(IPC.AGENT.SAVE_ICON)!;
    const result = await handler({}, '/project', 'agent-1', 'data:image/png;base64,abc');
    expect(agentConfig.saveAgentIcon).toHaveBeenCalledWith('/project', 'agent-1', 'data:image/png;base64,abc');
    expect(result).toBe('icon-filename.png');
    expect(broadcastSnapshotRefresh).toHaveBeenCalled();
  });

  it('READ_ICON delegates to agentConfig.readAgentIconData', async () => {
    const handler = handlers.get(IPC.AGENT.READ_ICON)!;
    const result = await handler({}, 'icon.png');
    expect(agentConfig.readAgentIconData).toHaveBeenCalledWith('icon.png');
    expect(result).toBe('data:image/png;base64,abc');
  });

  it('REMOVE_ICON delegates to agentConfig.removeAgentIcon', async () => {
    const handler = handlers.get(IPC.AGENT.REMOVE_ICON)!;
    await handler({}, '/project', 'agent-1');
    expect(agentConfig.removeAgentIcon).toHaveBeenCalledWith('/project', 'agent-1');
  });

  // --- Worktree & Delete variants ---

  it('GET_WORKTREE_STATUS delegates to agentConfig.getWorktreeStatus', async () => {
    const handler = handlers.get(IPC.AGENT.GET_WORKTREE_STATUS)!;
    const result = await handler({}, '/project', 'agent-1');
    expect(agentConfig.getWorktreeStatus).toHaveBeenCalledWith('/project', 'agent-1');
    expect(result).toEqual({ clean: true, branch: 'main' });
  });

  it('DELETE_COMMIT_PUSH delegates to agentConfig.deleteCommitAndPush', async () => {
    const handler = handlers.get(IPC.AGENT.DELETE_COMMIT_PUSH)!;
    const result = await handler({}, '/project', 'agent-1');
    expect(agentConfig.deleteCommitAndPush).toHaveBeenCalledWith('/project', 'agent-1');
    expect(result).toEqual({ ok: true });
  });

  it('DELETE_CLEANUP_BRANCH delegates to agentConfig.deleteWithCleanupBranch', async () => {
    const handler = handlers.get(IPC.AGENT.DELETE_CLEANUP_BRANCH)!;
    const result = await handler({}, '/project', 'agent-1');
    expect(agentConfig.deleteWithCleanupBranch).toHaveBeenCalledWith('/project', 'agent-1');
    expect(result).toEqual({ ok: true });
  });

  it('DELETE_SAVE_PATCH returns cancelled when no focused window', async () => {
    vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValueOnce(null);
    const handler = handlers.get(IPC.AGENT.DELETE_SAVE_PATCH)!;
    const result = await handler({}, '/project', 'agent-1');
    expect(result).toEqual({ ok: false, message: 'cancelled' });
    expect(dialog.showSaveDialog).not.toHaveBeenCalled();
  });

  it('DELETE_SAVE_PATCH returns cancelled when dialog is canceled', async () => {
    vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: true, filePath: undefined } as any);
    const handler = handlers.get(IPC.AGENT.DELETE_SAVE_PATCH)!;
    const result = await handler({}, '/project', 'agent-1');
    expect(result).toEqual({ ok: false, message: 'cancelled' });
  });

  it('DELETE_SAVE_PATCH calls deleteSaveAsPatch when dialog succeeds', async () => {
    vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: false, filePath: '/tmp/agent.patch' } as any);
    const handler = handlers.get(IPC.AGENT.DELETE_SAVE_PATCH)!;
    const result = await handler({}, '/project', 'agent-1');
    expect(agentConfig.deleteSaveAsPatch).toHaveBeenCalledWith('/project', 'agent-1', '/tmp/agent.patch');
    expect(result).toEqual({ ok: true, filePath: '/tmp/agent.patch' });
  });

  it('DELETE_FORCE delegates to agentConfig.deleteForce', async () => {
    const handler = handlers.get(IPC.AGENT.DELETE_FORCE)!;
    const result = await handler({}, '/project', 'agent-1');
    expect(agentConfig.deleteForce).toHaveBeenCalledWith('/project', 'agent-1');
    expect(result).toEqual({ ok: true });
  });

  it('DELETE_UNREGISTER delegates to agentConfig.deleteUnregister', async () => {
    const handler = handlers.get(IPC.AGENT.DELETE_UNREGISTER)!;
    const result = await handler({}, '/project', 'agent-1');
    expect(agentConfig.deleteUnregister).toHaveBeenCalledWith('/project', 'agent-1');
    expect(result).toEqual({ ok: true });
  });

  // --- Orchestrator-based ---

  it('SPAWN_AGENT delegates to agentSystem.spawnAgent', async () => {
    const params = { agentId: 'a1', projectPath: '/p', cwd: '/p', kind: 'durable' as const };
    const handler = handlers.get(IPC.AGENT.SPAWN_AGENT)!;
    await handler({}, params);
    expect(agentSystem.spawnAgent).toHaveBeenCalledWith(params);
  });

  it('SPAWN_AGENT logs and rethrows on error', async () => {
    vi.mocked(agentSystem.spawnAgent).mockRejectedValueOnce(new Error('spawn failed'));
    const handler = handlers.get(IPC.AGENT.SPAWN_AGENT)!;
    await expect(handler({}, { agentId: 'a1', projectPath: '/p', cwd: '/p', kind: 'durable', orchestrator: 'claude-code' })).rejects.toThrow('spawn failed');
    expect(appLog).toHaveBeenCalledWith('core:ipc', 'error', 'Agent spawn failed', expect.objectContaining({
      meta: expect.objectContaining({ agentId: 'a1', error: 'spawn failed' }),
    }));
  });

  it('KILL_AGENT delegates to agentSystem.killAgent', async () => {
    const handler = handlers.get(IPC.AGENT.KILL_AGENT)!;
    await handler({}, 'a1', '/project');
    expect(agentSystem.killAgent).toHaveBeenCalledWith('a1', '/project', undefined, 'user', { waitForExit: undefined });
  });

  it('KILL_AGENT passes waitForExit through for restarts that resume', async () => {
    const handler = handlers.get(IPC.AGENT.KILL_AGENT)!;
    await handler({}, 'a1', '/project', true);
    expect(agentSystem.killAgent).toHaveBeenCalledWith('a1', '/project', undefined, 'user', { waitForExit: true });
  });

  it('READ_QUICK_SUMMARY delegates to readQuickSummary', async () => {
    const handler = handlers.get(IPC.AGENT.READ_QUICK_SUMMARY)!;
    const result = await handler({}, 'a1');
    expect(readQuickSummary).toHaveBeenCalledWith('a1');
    expect(result).toBe('Quick summary');
  });

  it('GET_MODEL_OPTIONS delegates to provider.getModelOptions', async () => {
    const handler = handlers.get(IPC.AGENT.GET_MODEL_OPTIONS)!;
    const result = await handler({}, '/project', 'claude-code');
    expect(agentSystem.resolveOrchestrator).toHaveBeenCalledWith('/project', 'claude-code');
    expect(result).toEqual([{ id: 'default', label: 'Default' }]);
  });

  it('GET_MODEL_OPTIONS lists models under the project\'s profile env', async () => {
    const getModelOptions = vi.fn(async () => [{ id: 'default', label: 'Default' }]);
    vi.mocked(agentSystem.resolveOrchestrator).mockResolvedValueOnce({ id: 'codex-cli', getModelOptions } as never);
    vi.mocked(agentSystem.resolveProfileEnv).mockResolvedValueOnce({ CODEX_HOME: 'profile-home' });
    await handlers.get(IPC.AGENT.GET_MODEL_OPTIONS)!({}, '/project', 'codex-cli');
    expect(agentSystem.resolveProfileEnv).toHaveBeenCalledWith('/project', 'codex-cli');
    expect(getModelOptions).toHaveBeenCalledWith({ env: { CODEX_HOME: 'profile-home' } });
  });

  it('CHECK_ORCHESTRATOR delegates to agentSystem.checkAvailability', async () => {
    const handler = handlers.get(IPC.AGENT.CHECK_ORCHESTRATOR)!;
    const result = await handler({}, '/project', 'claude-code');
    expect(agentSystem.checkAvailability).toHaveBeenCalledWith('/project', 'claude-code');
    expect(result).toEqual({ available: true });
  });

  it('GET_ORCHESTRATORS delegates to agentSystem.getAvailableOrchestrators', async () => {
    const handler = handlers.get(IPC.AGENT.GET_ORCHESTRATORS)!;
    const result = await handler({});
    expect(agentSystem.getAvailableOrchestrators).toHaveBeenCalled();
    expect(result).toEqual(['claude-code', 'aider']);
  });

  it('GET_TOOL_VERB returns provider toolVerb result or fallback', async () => {
    const handler = handlers.get(IPC.AGENT.GET_TOOL_VERB)!;
    const result = await handler({}, 'unknown-tool', '/project');
    // toolVerb returns null for unknown → fallback to `Using ${toolName}`
    expect(result).toBe('Using unknown-tool');
  });

  it('GET_SUMMARY_INSTRUCTION delegates to buildSummaryInstruction', async () => {
    const handler = handlers.get(IPC.AGENT.GET_SUMMARY_INSTRUCTION)!;
    const result = await handler({}, 'a1');
    expect(buildSummaryInstruction).toHaveBeenCalledWith('a1');
    expect(result).toBe('Summarize the work done.');
  });

  it('READ_TRANSCRIPT delegates to headlessManager.readTranscript', async () => {
    const handler = handlers.get(IPC.AGENT.READ_TRANSCRIPT)!;
    const result = await handler({}, 'a1');
    expect(headlessManager.readTranscript).toHaveBeenCalledWith('a1');
    expect(result).toBe('transcript text');
  });

  it('GET_TRANSCRIPT_INFO delegates to headlessManager.getTranscriptInfo', async () => {
    const handler = handlers.get(IPC.AGENT.GET_TRANSCRIPT_INFO)!;
    const result = await handler({}, 'a1');
    expect(headlessManager.getTranscriptInfo).toHaveBeenCalledWith('a1');
    expect(result).toEqual({ totalEvents: 10, fileSizeBytes: 1024 });
  });

  it('READ_TRANSCRIPT_PAGE delegates to headlessManager.readTranscriptPage', async () => {
    const handler = handlers.get(IPC.AGENT.READ_TRANSCRIPT_PAGE)!;
    const result = await handler({}, 'a1', 0, 50);
    expect(headlessManager.readTranscriptPage).toHaveBeenCalledWith('a1', 0, 50);
    expect(result).toEqual({ events: [{ type: 'result' }], totalEvents: 10 });
  });

  it('READ_TRANSCRIPT_FROM delegates to headlessManager.readTranscriptFrom with the cursor', async () => {
    const handler = handlers.get(IPC.AGENT.READ_TRANSCRIPT_FROM)!;
    const result = await handler({}, 'a1', 1024);
    expect(headlessManager.readTranscriptFrom).toHaveBeenCalledWith('a1', 1024);
    expect(result).toMatchObject({ cursor: 42 });
  });

  it('IS_HEADLESS_AGENT delegates to agentSystem.isHeadlessAgent', async () => {
    const handler = handlers.get(IPC.AGENT.IS_HEADLESS_AGENT)!;
    const result = await handler({}, 'a1');
    expect(agentSystem.isHeadlessAgent).toHaveBeenCalledWith('a1');
    expect(result).toBe(false);
  });

  // --- Input validation ---

  it('rejects non-string projectPath for LIST_DURABLE', () => {
    const handler = handlers.get(IPC.AGENT.LIST_DURABLE)!;
    expect(() => handler({}, 123)).toThrow('must be a string');
  });

  it('rejects non-string agentId for DELETE_DURABLE', () => {
    const handler = handlers.get(IPC.AGENT.DELETE_DURABLE)!;
    expect(() => handler({}, '/project', null)).toThrow('must be a string');
  });

  it('rejects non-object updates for UPDATE_DURABLE', () => {
    const handler = handlers.get(IPC.AGENT.UPDATE_DURABLE)!;
    expect(() => handler({}, '/project', 'a1', 'not-an-object')).toThrow('must be an object');
  });

  it('rejects SPAWN_AGENT with missing required fields', () => {
    const handler = handlers.get(IPC.AGENT.SPAWN_AGENT)!;
    expect(() => handler({}, { agentId: 'a1' })).toThrow('projectPath must be a non-empty string');
  });

  it('rejects SPAWN_AGENT with non-object param', () => {
    const handler = handlers.get(IPC.AGENT.SPAWN_AGENT)!;
    expect(() => handler({}, 'not-an-object')).toThrow('must be an object');
  });

  it('rejects non-integer offset for READ_TRANSCRIPT_PAGE', () => {
    const handler = handlers.get(IPC.AGENT.READ_TRANSCRIPT_PAGE)!;
    expect(() => handler({}, 'a1', 1.5, 10)).toThrow('must be an integer');
  });

  // --- Persona on CREATE_DURABLE (#2223) ---

  it('CREATE_DURABLE with persona applies it via the shared layered lookup, keeping project defaults', async () => {
    vi.mocked(agentConfig.createDurable).mockResolvedValueOnce({
      id: 'agent-qa', name: 'qa-bot', color: 'red', worktreePath: '/wt/qa',
    } as any);
    // Front-matter settings applied by the persona show up in the returned config.
    vi.mocked(agentConfig.getDurableConfig).mockResolvedValueOnce({
      id: 'agent-qa', name: 'qa-bot', color: 'red', worktreePath: '/wt/qa', persona: 'reviewer', model: 'opus',
    } as any);

    const handler = handlers.get(IPC.AGENT.CREATE_DURABLE)!;
    const result = await handler({}, '/project', 'qa-bot', 'red', undefined, true, 'claude-code', false, undefined, undefined, 'reviewer');

    expect(applyPersonaToAgent).toHaveBeenCalledWith('/project', 'agent-qa', 'reviewer', { appendToExisting: true });
    expect(result).toEqual(expect.objectContaining({ id: 'agent-qa', persona: 'reviewer', model: 'opus' }));
  });

  it('CREATE_DURABLE with persona skips it when no worktree', async () => {
    vi.mocked(agentConfig.createDurable).mockResolvedValueOnce({
      id: 'agent-pm', name: 'pm-bot', color: 'indigo',
    } as any);

    const handler = handlers.get(IPC.AGENT.CREATE_DURABLE)!;
    await handler({}, '/project', 'pm-bot', 'indigo', undefined, false, undefined, false, undefined, undefined, 'qa');

    expect(applyPersonaToAgent).not.toHaveBeenCalled();
  });

  it('CREATE_DURABLE without persona does not apply one', async () => {
    vi.mocked(agentConfig.createDurable).mockResolvedValueOnce({
      id: 'agent-x', name: 'x-bot', color: 'blue', worktreePath: '/wt/x',
    } as any);

    const handler = handlers.get(IPC.AGENT.CREATE_DURABLE)!;
    await handler({}, '/project', 'x-bot', 'blue', undefined, true, undefined, false, undefined, undefined, undefined);

    expect(applyPersonaToAgent).not.toHaveBeenCalled();
  });

  it('CREATE_DURABLE still returns the agent when applying the persona fails', async () => {
    vi.mocked(agentConfig.createDurable).mockResolvedValueOnce({
      id: 'agent-qa2', name: 'qa-bot', color: 'red', worktreePath: '/wt/qa2',
    } as any);
    vi.mocked(applyPersonaToAgent).mockRejectedValueOnce(new Error('EACCES'));

    const handler = handlers.get(IPC.AGENT.CREATE_DURABLE)!;
    const result = await handler({}, '/project', 'qa-bot', 'red', undefined, true, 'claude-code', false, undefined, undefined, 'qa');

    expect(result).toEqual(expect.objectContaining({ id: 'agent-qa2' }));
    expect(appLog).toHaveBeenCalledWith('agents', 'warn', 'Failed to inject persona instructions on create', expect.anything());
  });

  // ── Durable permission queue (issue #1553) ─────────────────────────
  // These run against the real queue and agent registry: the point of the
  // channel is the authorization it enforces, which a mock would erase.
  describe('durable agent permissions', () => {
    beforeEach(() => {
      permissionQueue.reset();
      agentRegistry.untrack('agent-1');
      agentRegistry.untrack('agent-2');
      agentRegistry.register('agent-1', {
        projectPath: '/project', orchestrator: 'claude-code', runtime: 'pty',
      });
      agentRegistry.register('agent-2', {
        projectPath: '/project', orchestrator: 'claude-code', runtime: 'pty',
      });
    });

    it('registers the durable permission channels', () => {
      expect(handlers.has(IPC.AGENT.LIST_PENDING_PERMISSIONS)).toBe(true);
      expect(handlers.has(IPC.AGENT.RESOLVE_PENDING_PERMISSION)).toBe(true);
    });

    it('LIST_PENDING_PERMISSIONS returns everything when no agent is given', async () => {
      permissionQueue.createPermission('agent-1', 'Skill');
      permissionQueue.createPermission('agent-2', 'AskUserQuestion');

      const result = await handlers.get(IPC.AGENT.LIST_PENDING_PERMISSIONS)!({});

      expect(result).toHaveLength(2);
    });

    it('LIST_PENDING_PERMISSIONS filters by agent', async () => {
      permissionQueue.createPermission('agent-1', 'Skill');
      permissionQueue.createPermission('agent-2', 'AskUserQuestion');

      const result = await handlers.get(IPC.AGENT.LIST_PENDING_PERMISSIONS)!({}, 'agent-2');

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ agentId: 'agent-2', toolName: 'AskUserQuestion' });
    });

    it('RESOLVE_PENDING_PERMISSION applies an allow decision', async () => {
      const { requestId, decision } = permissionQueue.createPermission('agent-1', 'Skill');

      const result = await handlers.get(IPC.AGENT.RESOLVE_PENDING_PERMISSION)!(
        {}, 'agent-1', requestId, 'allow',
      );

      expect(result).toEqual({ status: 'resolved' });
      await expect(decision).resolves.toBe('allow');
    });

    it('RESOLVE_PENDING_PERMISSION applies a deny decision', async () => {
      const { requestId, decision } = permissionQueue.createPermission('agent-1', 'Skill');

      const result = await handlers.get(IPC.AGENT.RESOLVE_PENDING_PERMISSION)!(
        {}, 'agent-1', requestId, 'deny',
      );

      expect(result).toEqual({ status: 'resolved' });
      await expect(decision).resolves.toBe('deny');
    });

    it('rejects a decision value that is not allow/deny', async () => {
      const { requestId } = permissionQueue.createPermission('agent-1', 'Skill');

      for (const bad of ['ask', 'ALLOW', 'allow ', 'yes']) {
        const result = await handlers.get(IPC.AGENT.RESOLVE_PENDING_PERMISSION)!(
          {}, 'agent-1', requestId, bad,
        );
        expect(result).toEqual({ status: 'rejected', reason: 'invalid_decision' });
      }
      // Still pending — nothing was applied.
      expect(permissionQueue.getPermission(requestId)).toBeDefined();
    });

    it('rejects non-string arguments before they reach the queue', async () => {
      const { requestId } = permissionQueue.createPermission('agent-1', 'Skill');
      const handler = handlers.get(IPC.AGENT.RESOLVE_PENDING_PERMISSION)!;

      // withValidatedArgs rejects the call before the handler body runs, so
      // these throw synchronously rather than returning a rejected promise.
      expect(() => handler({}, 'agent-1', requestId, { toString: () => 'allow' })).toThrow(/must be a string/);
      expect(() => handler({}, 'agent-1', requestId, null)).toThrow(/must be a string/);
      expect(() => handler({}, 42, requestId, 'allow')).toThrow(/must be a string/);
      expect(() => handler({}, 'agent-1', '', 'allow')).toThrow(/at least 1 character/);
      expect(() => handler({}, 'agent-1', requestId)).toThrow(/must be a string/);

      expect(permissionQueue.getPermission(requestId)).toBeDefined();
    });

    it('refuses to resolve a request belonging to another agent', async () => {
      const { requestId, decision } = permissionQueue.createPermission('agent-1', 'Skill');

      // agent-2 is a legitimate registered agent — it still must not be able
      // to answer agent-1's permission request.
      const result = await handlers.get(IPC.AGENT.RESOLVE_PENDING_PERMISSION)!(
        {}, 'agent-2', requestId, 'allow',
      );

      expect(result).toEqual({ status: 'rejected', reason: 'agent_mismatch' });
      expect(permissionQueue.getPermission(requestId)).toBeDefined();
      permissionQueue.resolvePermission(requestId, 'deny');
      await expect(decision).resolves.toBe('deny');
    });

    it('refuses when the agent is not registered', async () => {
      const { requestId } = permissionQueue.createPermission('ghost', 'Skill');

      const result = await handlers.get(IPC.AGENT.RESOLVE_PENDING_PERMISSION)!(
        {}, 'ghost', requestId, 'allow',
      );

      expect(result).toEqual({ status: 'rejected', reason: 'unknown_agent' });
      expect(permissionQueue.getPermission(requestId)).toBeDefined();
    });

    it('refuses an unknown request id', async () => {
      const result = await handlers.get(IPC.AGENT.RESOLVE_PENDING_PERMISSION)!(
        {}, 'agent-1', 'not-a-real-request', 'allow',
      );

      expect(result).toEqual({ status: 'rejected', reason: 'not_found' });
    });

    it('refuses a request whose deadline has passed', async () => {
      vi.useFakeTimers();
      const { requestId } = permissionQueue.createPermission('agent-1', 'Skill', undefined, undefined, 1_000);
      vi.setSystemTime(Date.now() + 1_001);

      const result = await handlers.get(IPC.AGENT.RESOLVE_PENDING_PERMISSION)!(
        {}, 'agent-1', requestId, 'allow',
      );

      expect(result).toEqual({ status: 'rejected', reason: 'expired' });
      vi.useRealTimers();
    });

    it('a second decision on the same request is refused', async () => {
      const { requestId, decision } = permissionQueue.createPermission('agent-1', 'Skill');
      const handler = handlers.get(IPC.AGENT.RESOLVE_PENDING_PERMISSION)!;

      expect(await handler({}, 'agent-1', requestId, 'deny')).toEqual({ status: 'resolved' });
      expect(await handler({}, 'agent-1', requestId, 'allow')).toEqual({ status: 'rejected', reason: 'not_found' });

      await expect(decision).resolves.toBe('deny');
    });
  });

  describe('config change events', () => {
    it('tells the windows once per burst of config writes to a project', async () => {
      vi.useFakeTimers();
      try {
        const send = vi.fn();
        vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([{ isDestroyed: () => false, webContents: { isDestroyed: () => false, send } }] as never);
        expect(configChange.listener).toBeTypeOf('function');
        configChange.listener!('/project');
        configChange.listener!('/project');
        configChange.listener!('/other');
        expect(send).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(CONFIG_CHANGE_DEBOUNCE_MS);
        const sent = send.mock.calls.filter(([channel]) => channel === IPC.AGENT.CONFIGS_CHANGED);
        expect(sent).toEqual([[IPC.AGENT.CONFIGS_CHANGED, '/project'], [IPC.AGENT.CONFIGS_CHANGED, '/other']]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('refreshes the Annex snapshot only when an agent\'s name or look changed', async () => {
      vi.useFakeTimers();
      try {
        const write = async (agents: object[]) => {
          vi.mocked(agentConfig.listDurable).mockResolvedValue(agents as never);
          vi.mocked(broadcastSnapshotRefresh).mockClear();
          configChange.listener!('/phones');
          await vi.advanceTimersByTimeAsync(CONFIG_CHANGE_DEBOUNCE_MS);
          return vi.mocked(broadcastSnapshotRefresh).mock.calls.length;
        };
        const agent = { id: 'a1', name: 'Bot', color: 'rose' };
        expect(await write([agent])).toBe(1);
        expect(await write([{ ...agent, lastSessionId: 'new' }])).toBe(0);
        expect(await write([{ ...agent, color: 'teal' }])).toBe(1);
        expect(await write([{ ...agent, color: 'teal', emoji: '🦊' }])).toBe(1);
        expect(await write([{ ...agent, color: 'teal', icon: 'a1.png' }])).toBe(1);
        expect(await write([{ ...agent, name: 'Renamed', color: 'teal', icon: 'a1.png' }])).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('MCP change events (#2589)', () => {
    it('tells the windows when an app or project MCP setting changes', () => {
      const send = vi.fn();
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([{ isDestroyed: () => false, webContents: { isDestroyed: () => false, send } }] as never);
      notifyMcpEnablementChanged();
      expect(send.mock.calls.filter(([channel]) => channel === IPC.AGENT.MCP_ENABLEMENT_CHANGED)).toHaveLength(1);
    });
  });

  describe('GET_SESSION_SUMMARY (#2277)', () => {
    const SECRET = 'TOP-SECRET-SESSION-CONTENT';
    const provider = {
      id: 'copilot-cli',
      getCapabilities: () => ({ sessionResume: true }),
      listSessions: vi.fn(async () => []),
      extractSessionId: vi.fn(() => null),
      readSessionTranscript: vi.fn(async (_id: string, _cwd: string, _env: unknown, opts?: { stats?: Record<string, unknown> }) => {
        Object.assign(opts!.stats!, { lookupMs: 1.4, readMs: 2.6, probes: 2, found: true, fileBytes: 10, bytesRead: 10 });
        return [{ type: 'result', result: SECRET, timestamp: Date.now() }];
      }),
    };

    it('caps the transcript read and logs per-stage timing at debug, without content', async () => {
      vi.mocked(agentSystem.resolveOrchestrator).mockResolvedValueOnce(provider as never);
      const summary = await handlers.get(IPC.AGENT.GET_SESSION_SUMMARY)!({}, '/project', 'agent-1', 'sess-uuid-1', 'copilot-cli');
      expect(summary.summary).toBe(SECRET);

      const opts = provider.readSessionTranscript.mock.calls[0][3];
      expect(opts?.stats).toBeDefined();
      expect((opts as { maxBytes?: number }).maxBytes).toBeGreaterThan(0);

      const call = vi.mocked(appLog).mock.calls.find((c) => c[2] === 'Session summary timing');
      expect(call?.[1]).toBe('debug');
      const meta = call![3]!.meta!;
      expect(meta).toMatchObject({ provider: 'copilot-cli', probes: 2, lookupMs: 1, readMs: 3, rawEvents: 1 });
      for (const k of ['resolveMs', 'transcriptMs', 'summarizeMs', 'totalMs']) expect(typeof meta[k]).toBe('number');
      const logged = JSON.stringify(meta);
      expect(logged).not.toContain(SECRET);
      expect(logged).not.toContain('sess-uuid-1');
      expect(logged).not.toContain('/project');
    });

    it('still logs timing when the session is missing', async () => {
      vi.mocked(agentSystem.resolveOrchestrator).mockResolvedValueOnce({ ...provider, readSessionTranscript: vi.fn(async () => null) } as never);
      expect(await handlers.get(IPC.AGENT.GET_SESSION_SUMMARY)!({}, '/project', 'agent-1', 'sess-uuid-1')).toBeNull();
      const call = vi.mocked(appLog).mock.calls.find((c) => c[2] === 'Session summary timing');
      expect(call?.[3]?.meta).toMatchObject({ provider: 'copilot-cli' });
    });
  });
});

describe('agent-handlers: finished quick agents (#2467)', () => {
  let handlers: Map<string, (...args: any[]) => any>;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = new Map();
    vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: any) => {
      handlers.set(channel, handler);
    });
    registerAgentHandlers();
  });

  it('hands the window\'s localStorage lists to the store and returns the stored lists', async () => {
    const legacy = { p: [] };
    expect(await handlers.get(IPC.AGENT.FINISHED_QUICK_HYDRATE)!({}, legacy)).toEqual({ p: [] });
    expect(finishedQuickStore.hydrateFinishedQuickAgents).toHaveBeenCalledWith(legacy);
  });

  it('applies a valid op with its window and sequence, and refuses anything else', async () => {
    const op = { type: 'dismiss', projectId: 'p', agentId: 'quick_1' };
    await handlers.get(IPC.AGENT.FINISHED_QUICK_APPLY)!({}, 'window-1', 3, op);
    expect(finishedQuickStore.applyFinishedQuickAgentChange).toHaveBeenCalledWith(op, { clientId: 'window-1', seq: 3 });
    await expect(async () => handlers.get(IPC.AGENT.FINISHED_QUICK_APPLY)!({}, 'window-1', 4, { type: 'dismiss', projectId: 'p' })).rejects.toThrow();
    await expect(async () => handlers.get(IPC.AGENT.FINISHED_QUICK_APPLY)!({}, 'window-1', 4, { type: 'add', record: { id: 'x' } })).rejects.toThrow();
    await expect(async () => handlers.get(IPC.AGENT.FINISHED_QUICK_APPLY)!({}, 'window-1', 0, op)).rejects.toThrow();
    expect(finishedQuickStore.applyFinishedQuickAgentChange).toHaveBeenCalledTimes(1);
  });

  it('broadcasts every change to the windows', () => {
    const send = vi.fn();
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([{ isDestroyed: () => false, webContents: { isDestroyed: () => false, send } }] as never);
    const listener = vi.mocked(finishedQuickStore.onFinishedQuickAgentsChange).mock.calls.at(-1)![0];
    const change = { state: { p: [] }, acked: { w: 1 } };
    listener(change);
    expect(send).toHaveBeenCalledWith(IPC.AGENT.FINISHED_QUICK_CHANGED, change);
  });
});
