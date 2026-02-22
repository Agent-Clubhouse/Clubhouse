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
  listDurable: vi.fn(async () => []),
  createDurable: vi.fn(async () => ({ id: 'agent-1', name: 'Test' })),
  deleteDurable: vi.fn(),
  renameDurable: vi.fn(),
  updateDurable: vi.fn(),
  saveAgentIcon: vi.fn(async () => 'icon.png'),
  readAgentIconData: vi.fn(async () => 'data:image/png;base64,abc'),
  removeAgentIcon: vi.fn(),
  getDurableConfig: vi.fn(async () => ({ id: 'agent-1' })),
  updateDurableConfig: vi.fn(),
  reorderDurable: vi.fn(),
  getWorktreeStatus: vi.fn(async () => ({ clean: true })),
  deleteCommitAndPush: vi.fn(async () => ({ ok: true })),
  deleteWithCleanupBranch: vi.fn(async () => ({ ok: true })),
  deleteSaveAsPatch: vi.fn(async () => ({ ok: true })),
  deleteForce: vi.fn(async () => ({ ok: true })),
  deleteUnregister: vi.fn(async () => ({ ok: true })),
}));

vi.mock('../services/agent-system', () => ({
  spawnAgent: vi.fn(async () => {}),
  killAgent: vi.fn(async () => {}),
  resolveOrchestrator: vi.fn(() => ({
    getModelOptions: vi.fn(async () => [{ id: 'default', label: 'Default' }]),
    toolVerb: vi.fn(() => 'Using tool'),
  })),
  checkAvailability: vi.fn(async () => ({ available: true })),
  getAvailableOrchestrators: vi.fn(() => []),
  isHeadlessAgent: vi.fn(() => false),
}));

vi.mock('../services/headless-manager', () => ({
  readTranscript: vi.fn(async () => 'transcript text'),
}));

vi.mock('../orchestrators/shared', () => ({
  buildSummaryInstruction: vi.fn(() => 'Summarize...'),
  readQuickSummary: vi.fn(async () => 'Quick summary'),
}));

vi.mock('../services/log-service', () => ({
  appLog: vi.fn(),
}));

// Stub fs and path for PICK_ICON handler
vi.mock('fs', () => ({
  readFileSync: vi.fn(() => Buffer.from('fakepng')),
}));

vi.mock('path', () => ({
  extname: vi.fn(() => '.png'),
  join: vi.fn((...args: string[]) => args.join('/')),
}));

import { ipcMain, dialog, BrowserWindow } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { registerAgentHandlers } from './agent-handlers';
import * as agentConfig from '../services/agent-config';
import * as agentSystem from '../services/agent-system';
import * as headlessManager from '../services/headless-manager';

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

  it('LIST_DURABLE delegates to agentConfig.listDurable', async () => {
    const handler = handlers.get(IPC.AGENT.LIST_DURABLE)!;
    await handler({}, '/project');
    expect(agentConfig.listDurable).toHaveBeenCalledWith('/project');
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

  it('DELETE_SAVE_PATCH returns cancelled when dialog is canceled', async () => {
    vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: true, filePath: undefined } as any);
    const handler = handlers.get(IPC.AGENT.DELETE_SAVE_PATCH)!;
    const result = await handler({}, '/project', 'agent-1');
    expect(result).toEqual({ ok: false, message: 'cancelled' });
  });

  it('SPAWN_AGENT delegates to agentSystem.spawnAgent', async () => {
    const params = { agentId: 'a1', projectPath: '/p', cwd: '/p', kind: 'durable' as const };
    const handler = handlers.get(IPC.AGENT.SPAWN_AGENT)!;
    await handler({}, params);
    expect(agentSystem.spawnAgent).toHaveBeenCalledWith(params);
  });

  it('KILL_AGENT delegates to agentSystem.killAgent', async () => {
    const handler = handlers.get(IPC.AGENT.KILL_AGENT)!;
    await handler({}, 'a1', '/project', 'claude-code');
    expect(agentSystem.killAgent).toHaveBeenCalledWith('a1', '/project', 'claude-code');
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

  it('CHECK_ORCHESTRATOR delegates to agentSystem.checkAvailability', async () => {
    const handler = handlers.get(IPC.AGENT.CHECK_ORCHESTRATOR)!;
    const result = await handler({}, '/project', 'claude-code');
    expect(agentSystem.checkAvailability).toHaveBeenCalledWith('/project', 'claude-code');
    expect(result).toEqual({ available: true });
  });

  it('GET_ORCHESTRATORS delegates to agentSystem.getAvailableOrchestrators', async () => {
    const handler = handlers.get(IPC.AGENT.GET_ORCHESTRATORS)!;
    await handler({});
    expect(agentSystem.getAvailableOrchestrators).toHaveBeenCalled();
  });
});
