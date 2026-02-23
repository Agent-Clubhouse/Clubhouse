import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: {
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    showSaveDialog: vi.fn(async () => ({ canceled: true })),
  },
  BrowserWindow: {
    getFocusedWindow: vi.fn(() => ({ id: 1 })),
  },
}));

vi.mock('../services/agent-config', () => ({
  listDurable: vi.fn(() => [{ id: 'a1', name: 'Bot' }]),
  createDurable: vi.fn(() => ({ id: 'agent-1', name: 'Test' })),
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
}));

vi.mock('../services/agent-system', () => ({
  spawnAgent: vi.fn(async () => {}),
  killAgent: vi.fn(async () => {}),
  resolveOrchestrator: vi.fn(() => ({
    getModelOptions: vi.fn(() => [{ id: 'default', label: 'Default' }]),
    toolVerb: vi.fn((name: string) => name === 'known' ? 'Editing' : null),
  })),
  checkAvailability: vi.fn(async () => ({ available: true })),
  getAvailableOrchestrators: vi.fn(() => ['claude-code', 'aider']),
  isHeadlessAgent: vi.fn(() => false),
}));

vi.mock('../services/headless-manager', () => ({
  readTranscript: vi.fn(() => 'transcript text'),
}));

vi.mock('../orchestrators/shared', () => ({
  buildSummaryInstruction: vi.fn(() => 'Summarize the work done.'),
  readQuickSummary: vi.fn(async () => 'Quick summary'),
}));

vi.mock('../services/log-service', () => ({
  appLog: vi.fn(),
}));

import { ipcMain, dialog, BrowserWindow } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { registerAgentHandlers } from './agent-handlers';
import * as agentConfig from '../services/agent-config';
import * as agentSystem from '../services/agent-system';
import * as headlessManager from '../services/headless-manager';
import { buildSummaryInstruction, readQuickSummary } from '../orchestrators/shared';
import { appLog } from '../services/log-service';

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
      IPC.AGENT.READ_TRANSCRIPT, IPC.AGENT.IS_HEADLESS_AGENT,
    ];
    for (const channel of expectedChannels) {
      expect(handlers.has(channel)).toBe(true);
    }
  });

  // --- CRUD ---

  it('LIST_DURABLE delegates to agentConfig.listDurable', async () => {
    const handler = handlers.get(IPC.AGENT.LIST_DURABLE)!;
    const result = await handler({}, '/project');
    expect(agentConfig.listDurable).toHaveBeenCalledWith('/project');
    expect(result).toEqual([{ id: 'a1', name: 'Bot' }]);
  });

  it('CREATE_DURABLE delegates to agentConfig.createDurable', async () => {
    const handler = handlers.get(IPC.AGENT.CREATE_DURABLE)!;
    const result = await handler({}, '/project', 'Bot', '#ff0000', 'gpt-5', true, 'claude-code', false);
    expect(agentConfig.createDurable).toHaveBeenCalledWith('/project', 'Bot', '#ff0000', 'gpt-5', true, 'claude-code', false);
    expect(result).toEqual({ id: 'agent-1', name: 'Test' });
  });

  it('DELETE_DURABLE delegates to agentConfig.deleteDurable', async () => {
    const handler = handlers.get(IPC.AGENT.DELETE_DURABLE)!;
    await handler({}, '/project', 'agent-1');
    expect(agentConfig.deleteDurable).toHaveBeenCalledWith('/project', 'agent-1');
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

  it('REORDER_DURABLE delegates to agentConfig.reorderDurable', async () => {
    const handler = handlers.get(IPC.AGENT.REORDER_DURABLE)!;
    await handler({}, '/project', ['a2', 'a1', 'a3']);
    expect(agentConfig.reorderDurable).toHaveBeenCalledWith('/project', ['a2', 'a1', 'a3']);
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
    await expect(handler({}, { agentId: 'a1', kind: 'durable', orchestrator: 'claude-code' })).rejects.toThrow('spawn failed');
    expect(appLog).toHaveBeenCalledWith('core:ipc', 'error', 'Agent spawn failed', expect.objectContaining({
      meta: expect.objectContaining({ agentId: 'a1', error: 'spawn failed' }),
    }));
  });

  it('KILL_AGENT delegates to agentSystem.killAgent', async () => {
    const handler = handlers.get(IPC.AGENT.KILL_AGENT)!;
    await handler({}, 'a1', '/project', 'claude-code');
    expect(agentSystem.killAgent).toHaveBeenCalledWith('a1', '/project', 'claude-code');
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

  it('IS_HEADLESS_AGENT delegates to agentSystem.isHeadlessAgent', async () => {
    const handler = handlers.get(IPC.AGENT.IS_HEADLESS_AGENT)!;
    const result = await handler({}, 'a1');
    expect(agentSystem.isHeadlessAgent).toHaveBeenCalledWith('a1');
    expect(result).toBe(false);
  });
});
