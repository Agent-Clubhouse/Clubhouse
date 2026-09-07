import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';
import type { AgentHookEvent, DurableConfigUpdates } from '../shared/types';
import type { PendingPermissionInfo, PermissionSettledInfo, PermissionResolveOutcome } from '../shared/permission-types';

export const agent = {
  agent: {
  listDurable: (projectPath: string) =>
    ipcRenderer.invoke(IPC.AGENT.LIST_DURABLE, projectPath),
  getRunningStatuses: (agentIds: string[]): Promise<string[]> =>
    ipcRenderer.invoke(IPC.AGENT.GET_RUNNING_STATUSES, agentIds),
  createDurable: (projectPath: string, name: string, color: string, model?: string, useWorktree?: boolean, orchestrator?: string, freeAgentMode?: boolean, mcpIds?: string[], mcpConfigs?: Record<string, Record<string, string>>, structuredMode?: boolean, persona?: string) =>
    ipcRenderer.invoke(IPC.AGENT.CREATE_DURABLE, projectPath, name, color, model, useWorktree, orchestrator, freeAgentMode, mcpIds, mcpConfigs, structuredMode, persona),
  deleteDurable: (projectPath: string, agentId: string) =>
    ipcRenderer.invoke(IPC.AGENT.DELETE_DURABLE, projectPath, agentId),
  renameDurable: (projectPath: string, agentId: string, newName: string) =>
    ipcRenderer.invoke(IPC.AGENT.RENAME_DURABLE, projectPath, agentId, newName),
  updateDurable: (projectPath: string, agentId: string, updates: { name?: string; color?: string; icon?: string | null; emoji?: string | null }) =>
    ipcRenderer.invoke(IPC.AGENT.UPDATE_DURABLE, projectPath, agentId, updates),
  pickIcon: () =>
    ipcRenderer.invoke(IPC.AGENT.PICK_ICON),
  saveIcon: (projectPath: string, agentId: string, dataUrl: string) =>
    ipcRenderer.invoke(IPC.AGENT.SAVE_ICON, projectPath, agentId, dataUrl),
  readIcon: (filename: string) =>
    ipcRenderer.invoke(IPC.AGENT.READ_ICON, filename),
  removeIcon: (projectPath: string, agentId: string) =>
    ipcRenderer.invoke(IPC.AGENT.REMOVE_ICON, projectPath, agentId),
  reorderDurable: (projectPath: string, orderedIds: string[]) =>
    ipcRenderer.invoke(IPC.AGENT.REORDER_DURABLE, projectPath, orderedIds),
  getWorktreeStatus: (projectPath: string, agentId: string) =>
    ipcRenderer.invoke(IPC.AGENT.GET_WORKTREE_STATUS, projectPath, agentId),
  deleteCommitPush: (projectPath: string, agentId: string) =>
    ipcRenderer.invoke(IPC.AGENT.DELETE_COMMIT_PUSH, projectPath, agentId),
  deleteCleanupBranch: (projectPath: string, agentId: string) =>
    ipcRenderer.invoke(IPC.AGENT.DELETE_CLEANUP_BRANCH, projectPath, agentId),
  deleteSavePatch: (projectPath: string, agentId: string) =>
    ipcRenderer.invoke(IPC.AGENT.DELETE_SAVE_PATCH, projectPath, agentId),
  deleteForce: (projectPath: string, agentId: string) =>
    ipcRenderer.invoke(IPC.AGENT.DELETE_FORCE, projectPath, agentId),
  deleteUnregister: (projectPath: string, agentId: string) =>
    ipcRenderer.invoke(IPC.AGENT.DELETE_UNREGISTER, projectPath, agentId),
  readQuickSummary: (agentId: string, projectPath?: string) =>
    ipcRenderer.invoke(IPC.AGENT.READ_QUICK_SUMMARY, agentId, projectPath),
  getDurableConfig: (projectPath: string, agentId: string) =>
    ipcRenderer.invoke(IPC.AGENT.GET_DURABLE_CONFIG, projectPath, agentId),
  updateDurableConfig: (projectPath: string, agentId: string, updates: DurableConfigUpdates) =>
    ipcRenderer.invoke(IPC.AGENT.UPDATE_DURABLE_CONFIG, projectPath, agentId, updates),

  // New orchestrator-based methods
  spawnAgent: (params: {
    agentId: string;
    projectPath: string;
    cwd: string;
    kind: 'durable' | 'quick' | 'companion';
    model?: string;
    mission?: string;
    systemPrompt?: string;
    allowedTools?: string[];
    orchestrator?: string;
    freeAgentMode?: boolean;
    structuredMode?: boolean;
    resume?: boolean;
    sessionId?: string;
    pluginOwner?: string;
    companionWorkspace?: string;
    permissionMode?: 'auto' | 'skip-all';
  }) => ipcRenderer.invoke(IPC.AGENT.SPAWN_AGENT, params),

  killAgent: (agentId: string, projectPath: string) =>
    ipcRenderer.invoke(IPC.AGENT.KILL_AGENT, agentId, projectPath),

  spawnCompanion: (pluginId: string, options?: { model?: string; systemPrompt?: string }) =>
    ipcRenderer.invoke(IPC.AGENT.SPAWN_COMPANION, pluginId, options),

  getCompanionStatus: (pluginId: string) =>
    ipcRenderer.invoke(IPC.AGENT.GET_COMPANION_STATUS, pluginId),

  getCompanionWorkspace: (pluginId: string) =>
    ipcRenderer.invoke(IPC.AGENT.GET_COMPANION_WORKSPACE, pluginId),

  getModelOptions: (projectPath: string, orchestrator?: string) =>
    ipcRenderer.invoke(IPC.AGENT.GET_MODEL_OPTIONS, projectPath, orchestrator),

  checkOrchestrator: (projectPath?: string, orchestrator?: string) =>
    ipcRenderer.invoke(IPC.AGENT.CHECK_ORCHESTRATOR, projectPath, orchestrator),

  getOrchestrators: () =>
    ipcRenderer.invoke(IPC.AGENT.GET_ORCHESTRATORS),

  getToolVerb: (toolName: string, projectPath: string, orchestrator?: string) =>
    ipcRenderer.invoke(IPC.AGENT.GET_TOOL_VERB, toolName, projectPath, orchestrator),

  getSummaryInstruction: (agentId: string, projectPath: string, orchestrator?: string) =>
    ipcRenderer.invoke(IPC.AGENT.GET_SUMMARY_INSTRUCTION, agentId, projectPath, orchestrator),

  readTranscript: (agentId: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.AGENT.READ_TRANSCRIPT, agentId),

  getTranscriptInfo: (agentId: string): Promise<{ totalEvents: number; fileSizeBytes: number } | null> =>
    ipcRenderer.invoke(IPC.AGENT.GET_TRANSCRIPT_INFO, agentId),

  readTranscriptPage: (agentId: string, offset: number, limit: number): Promise<{ events: unknown[]; totalEvents: number } | null> =>
    ipcRenderer.invoke(IPC.AGENT.READ_TRANSCRIPT_PAGE, agentId, offset, limit),

  isHeadlessAgent: (agentId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.AGENT.IS_HEADLESS_AGENT, agentId),

  onHookEvent: (callback: (agentId: string, event: {
    kind: string;
    toolName?: string;
    toolInput?: Record<string, unknown>;
    message?: string;
    toolVerb?: string;
    timestamp: number;
  }) => void) => {
    // Hook events may arrive as a single event or as a batched array
    // (the broadcast policy merges events within a 50ms window).
    const listener = (_event: Electron.IpcRendererEvent, agentId: string, hookEventOrBatch: AgentHookEvent | AgentHookEvent[]) => {
      if (Array.isArray(hookEventOrBatch)) {
        for (const ev of hookEventOrBatch) {
          callback(agentId, ev);
        }
      } else {
        callback(agentId, hookEventOrBatch);
      }
    };
    ipcRenderer.on(IPC.AGENT.HOOK_EVENT, listener);
    return () => { ipcRenderer.removeListener(IPC.AGENT.HOOK_EVENT, listener); };
  },

  onAgentWaking: (callback: (agentId: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, agentId: string) =>
      callback(agentId);
    ipcRenderer.on(IPC.AGENT.AGENT_WAKING, listener);
    return () => { ipcRenderer.removeListener(IPC.AGENT.AGENT_WAKING, listener); };
  },

  onAgentAwoke: (callback: (agentId: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, agentId: string) =>
      callback(agentId);
    ipcRenderer.on(IPC.AGENT.AGENT_AWOKE, listener);
    return () => { ipcRenderer.removeListener(IPC.AGENT.AGENT_AWOKE, listener); };
  },

  onAgentWakeFailed: (callback: (agentId: string, errorMessage: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, agentId: string, errorMessage: string) =>
      callback(agentId, errorMessage);
    ipcRenderer.on(IPC.AGENT.AGENT_WAKE_FAILED, listener);
    return () => { ipcRenderer.removeListener(IPC.AGENT.AGENT_WAKE_FAILED, listener); };
  },

  onAgentSleeping: (callback: (agentId: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, agentId: string) =>
      callback(agentId);
    ipcRenderer.on(IPC.AGENT.AGENT_SLEEPING, listener);
    return () => { ipcRenderer.removeListener(IPC.AGENT.AGENT_SLEEPING, listener); };
  },

  listSessions: (projectPath: string, agentId: string, orchestrator?: string): Promise<Array<{
    sessionId: string;
    startedAt: string;
    lastActiveAt: string;
    friendlyName?: string;
  }>> =>
    ipcRenderer.invoke(IPC.AGENT.LIST_SESSIONS, projectPath, agentId, orchestrator),

  updateSessionName: (projectPath: string, agentId: string, sessionId: string, friendlyName: string | null) =>
    ipcRenderer.invoke(IPC.AGENT.UPDATE_SESSION_NAME, projectPath, agentId, sessionId, friendlyName),

  readSessionTranscript: (projectPath: string, agentId: string, sessionId: string, offset: number, limit: number, orchestrator?: string): Promise<{
    events: Array<{
      id: string;
      timestamp: number;
      type: string;
      toolName?: string;
      toolInput?: Record<string, unknown>;
      text?: string;
      filePath?: string;
      usage?: { inputTokens: number; outputTokens: number };
      costUsd?: number;
      durationMs?: number;
      model?: string;
    }>;
    totalEvents: number;
  } | null> =>
    ipcRenderer.invoke(IPC.AGENT.READ_SESSION_TRANSCRIPT, projectPath, agentId, sessionId, offset, limit, orchestrator),

  getSessionSummary: (projectPath: string, agentId: string, sessionId: string, orchestrator?: string): Promise<{
    summary: string | null;
    filesModified: string[];
    totalToolCalls: number;
    toolsUsed: string[];
    totalCostUsd: number;
    totalDurationMs: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    model: string | null;
    orchestrator: string | null;
    eventCount: number;
    startedAt: string | null;
    lastActiveAt: string | null;
  } | null> =>
    ipcRenderer.invoke(IPC.AGENT.GET_SESSION_SUMMARY, projectPath, agentId, sessionId, orchestrator),

  // Structured mode
  startStructured: (agentId: string, opts: {
    mission: string;
    systemPrompt?: string;
    model?: string;
    cwd: string;
    env?: Record<string, string>;
    sessionId?: string;
    allowedTools?: string[];
    disallowedTools?: string[];
    freeAgentMode?: boolean;
  }) =>
    ipcRenderer.invoke(IPC.AGENT.START_STRUCTURED, agentId, opts),

  cancelStructured: (agentId: string) =>
    ipcRenderer.invoke(IPC.AGENT.CANCEL_STRUCTURED, agentId),

  sendStructuredMessage: (agentId: string, message: string) =>
    ipcRenderer.invoke(IPC.AGENT.SEND_STRUCTURED_MESSAGE, agentId, message),

  respondPermission: (agentId: string, requestId: string, approved: boolean, reason?: string) =>
    ipcRenderer.invoke(IPC.AGENT.RESPOND_PERMISSION, agentId, requestId, approved, reason),

  // Durable (PTY) agent permission queue — desktop-local approve/deny.
  listPendingPermissions: (agentId?: string): Promise<PendingPermissionInfo[]> =>
    ipcRenderer.invoke(IPC.AGENT.LIST_PENDING_PERMISSIONS, agentId),

  resolvePendingPermission: (
    agentId: string,
    requestId: string,
    decision: 'allow' | 'deny',
  ): Promise<PermissionResolveOutcome> =>
    ipcRenderer.invoke(IPC.AGENT.RESOLVE_PENDING_PERMISSION, agentId, requestId, decision),

  onPermissionPending: (callback: (agentId: string, permission: PendingPermissionInfo) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, agentId: string, permission: PendingPermissionInfo) =>
      callback(agentId, permission);
    ipcRenderer.on(IPC.AGENT.PERMISSION_PENDING, listener);
    return () => { ipcRenderer.removeListener(IPC.AGENT.PERMISSION_PENDING, listener); };
  },

  onPermissionSettled: (callback: (agentId: string, settled: PermissionSettledInfo) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, agentId: string, settled: PermissionSettledInfo) =>
      callback(agentId, settled);
    ipcRenderer.on(IPC.AGENT.PERMISSION_SETTLED, listener);
    return () => { ipcRenderer.removeListener(IPC.AGENT.PERMISSION_SETTLED, listener); };
  },

  // Backup & recovery
  getBackupInfo: (projectPath: string) =>
    ipcRenderer.invoke(IPC.AGENT.GET_BACKUP_INFO, projectPath),
  restoreFromBackup: (projectPath: string) =>
    ipcRenderer.invoke(IPC.AGENT.RESTORE_FROM_BACKUP, projectPath),

  onStructuredEvent: (callback: (agentId: string, event: {
    type: string;
    timestamp: number;
    data: unknown;
  }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, agentId: string, structuredEvent: Parameters<typeof callback>[1]) =>
      callback(agentId, structuredEvent);
    ipcRenderer.on(IPC.AGENT.STRUCTURED_EVENT, listener);
    return () => { ipcRenderer.removeListener(IPC.AGENT.STRUCTURED_EVENT, listener); };
  },
  },
};
