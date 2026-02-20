import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';

const api = {
  platform: process.platform as 'darwin' | 'win32' | 'linux',
  pty: {
    spawnShell: (id: string, projectPath: string) =>
      ipcRenderer.invoke(IPC.PTY.SPAWN_SHELL, id, projectPath),
    write: (agentId: string, data: string) =>
      ipcRenderer.send(IPC.PTY.WRITE, agentId, data),
    resize: (agentId: string, cols: number, rows: number) =>
      ipcRenderer.send(IPC.PTY.RESIZE, agentId, cols, rows),
    kill: (agentId: string) =>
      ipcRenderer.invoke(IPC.PTY.KILL, agentId),
    getBuffer: (agentId: string): Promise<string> =>
      ipcRenderer.invoke(IPC.PTY.GET_BUFFER, agentId),
    onData: (callback: (agentId: string, data: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, agentId: string, data: string) =>
        callback(agentId, data);
      ipcRenderer.on(IPC.PTY.DATA, listener);
      return () => { ipcRenderer.removeListener(IPC.PTY.DATA, listener); };
    },
    onExit: (callback: (agentId: string, exitCode: number) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, agentId: string, exitCode: number) =>
        callback(agentId, exitCode);
      ipcRenderer.on(IPC.PTY.EXIT, listener);
      return () => { ipcRenderer.removeListener(IPC.PTY.EXIT, listener); };
    },
  },
  project: {
    list: () => ipcRenderer.invoke(IPC.PROJECT.LIST),
    add: (path: string) => ipcRenderer.invoke(IPC.PROJECT.ADD, path),
    remove: (id: string) => ipcRenderer.invoke(IPC.PROJECT.REMOVE, id),
    pickDirectory: () => ipcRenderer.invoke(IPC.PROJECT.PICK_DIR),
    checkGit: (dirPath: string) => ipcRenderer.invoke(IPC.PROJECT.CHECK_GIT, dirPath),
    gitInit: (dirPath: string) => ipcRenderer.invoke(IPC.PROJECT.GIT_INIT, dirPath),
    update: (id: string, updates: Record<string, unknown>) =>
      ipcRenderer.invoke(IPC.PROJECT.UPDATE, id, updates),
    pickIcon: (projectId: string) =>
      ipcRenderer.invoke(IPC.PROJECT.PICK_ICON, projectId),
    reorder: (orderedIds: string[]) =>
      ipcRenderer.invoke(IPC.PROJECT.REORDER, orderedIds),
    readIcon: (filename: string) =>
      ipcRenderer.invoke(IPC.PROJECT.READ_ICON, filename),
    pickImage: () =>
      ipcRenderer.invoke(IPC.PROJECT.PICK_IMAGE),
    saveCroppedIcon: (projectId: string, dataUrl: string) =>
      ipcRenderer.invoke(IPC.PROJECT.SAVE_CROPPED_ICON, projectId, dataUrl),
    listClubhouseFiles: (projectPath: string): Promise<string[]> =>
      ipcRenderer.invoke(IPC.PROJECT.LIST_CLUBHOUSE_FILES, projectPath),
    resetProject: (projectPath: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC.PROJECT.RESET_PROJECT, projectPath),
  },
  agent: {
    listDurable: (projectPath: string) =>
      ipcRenderer.invoke(IPC.AGENT.LIST_DURABLE, projectPath),
    createDurable: (projectPath: string, name: string, color: string, model?: string, useWorktree?: boolean, orchestrator?: string, freeAgentMode?: boolean) =>
      ipcRenderer.invoke(IPC.AGENT.CREATE_DURABLE, projectPath, name, color, model, useWorktree, orchestrator, freeAgentMode),
    deleteDurable: (projectPath: string, agentId: string) =>
      ipcRenderer.invoke(IPC.AGENT.DELETE_DURABLE, projectPath, agentId),
    renameDurable: (projectPath: string, agentId: string, newName: string) =>
      ipcRenderer.invoke(IPC.AGENT.RENAME_DURABLE, projectPath, agentId, newName),
    updateDurable: (projectPath: string, agentId: string, updates: { name?: string; color?: string; icon?: string | null }) =>
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
    updateDurableConfig: (projectPath: string, agentId: string, updates: any) =>
      ipcRenderer.invoke(IPC.AGENT.UPDATE_DURABLE_CONFIG, projectPath, agentId, updates),

    // New orchestrator-based methods
    spawnAgent: (params: {
      agentId: string;
      projectPath: string;
      cwd: string;
      kind: 'durable' | 'quick';
      model?: string;
      mission?: string;
      systemPrompt?: string;
      allowedTools?: string[];
      orchestrator?: string;
      freeAgentMode?: boolean;
    }) => ipcRenderer.invoke(IPC.AGENT.SPAWN_AGENT, params),

    killAgent: (agentId: string, projectPath: string, orchestrator?: string) =>
      ipcRenderer.invoke(IPC.AGENT.KILL_AGENT, agentId, projectPath, orchestrator),

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
      const listener = (_event: Electron.IpcRendererEvent, agentId: string, hookEvent: any) =>
        callback(agentId, hookEvent);
      ipcRenderer.on(IPC.AGENT.HOOK_EVENT, listener);
      return () => { ipcRenderer.removeListener(IPC.AGENT.HOOK_EVENT, listener); };
    },
  },
  git: {
    info: (dirPath: string) => ipcRenderer.invoke(IPC.GIT.INFO, dirPath),
    checkout: (dirPath: string, branch: string) =>
      ipcRenderer.invoke(IPC.GIT.CHECKOUT, dirPath, branch),
    stage: (dirPath: string, filePath: string) =>
      ipcRenderer.invoke(IPC.GIT.STAGE, dirPath, filePath),
    unstage: (dirPath: string, filePath: string) =>
      ipcRenderer.invoke(IPC.GIT.UNSTAGE, dirPath, filePath),
    stageAll: (dirPath: string) =>
      ipcRenderer.invoke(IPC.GIT.STAGE_ALL, dirPath),
    unstageAll: (dirPath: string) =>
      ipcRenderer.invoke(IPC.GIT.UNSTAGE_ALL, dirPath),
    discard: (dirPath: string, filePath: string, isUntracked: boolean) =>
      ipcRenderer.invoke(IPC.GIT.DISCARD, dirPath, filePath, isUntracked),
    commit: (dirPath: string, message: string) =>
      ipcRenderer.invoke(IPC.GIT.COMMIT, dirPath, message),
    push: (dirPath: string) => ipcRenderer.invoke(IPC.GIT.PUSH, dirPath),
    pull: (dirPath: string) => ipcRenderer.invoke(IPC.GIT.PULL, dirPath),
    diff: (dirPath: string, filePath: string, staged: boolean) =>
      ipcRenderer.invoke(IPC.GIT.DIFF, dirPath, filePath, staged),
    createBranch: (dirPath: string, branchName: string) =>
      ipcRenderer.invoke(IPC.GIT.CREATE_BRANCH, dirPath, branchName),
    stash: (dirPath: string) => ipcRenderer.invoke(IPC.GIT.STASH, dirPath),
    stashPop: (dirPath: string) => ipcRenderer.invoke(IPC.GIT.STASH_POP, dirPath),
  },
  agentSettings: {
    readInstructions: (worktreePath: string, projectPath?: string) =>
      ipcRenderer.invoke(IPC.AGENT.READ_INSTRUCTIONS, worktreePath, projectPath),
    saveInstructions: (worktreePath: string, content: string, projectPath?: string) =>
      ipcRenderer.invoke(IPC.AGENT.SAVE_INSTRUCTIONS, worktreePath, content, projectPath),
    readMcpConfig: (worktreePath: string, projectPath?: string) =>
      ipcRenderer.invoke(IPC.AGENT.READ_MCP_CONFIG, worktreePath, projectPath),
    listSkills: (worktreePath: string, projectPath?: string) =>
      ipcRenderer.invoke(IPC.AGENT.LIST_SKILLS, worktreePath, projectPath),
    listAgentTemplates: (worktreePath: string, projectPath?: string) =>
      ipcRenderer.invoke(IPC.AGENT.LIST_AGENT_TEMPLATES, worktreePath, projectPath),
    listSourceSkills: (projectPath: string) =>
      ipcRenderer.invoke(IPC.AGENT.LIST_SOURCE_SKILLS, projectPath),
    listSourceAgentTemplates: (projectPath: string) =>
      ipcRenderer.invoke(IPC.AGENT.LIST_SOURCE_AGENT_TEMPLATES, projectPath),
    createSkill: (basePath: string, name: string, isSource: boolean, projectPath?: string) =>
      ipcRenderer.invoke(IPC.AGENT.CREATE_SKILL, basePath, name, isSource, projectPath),
    createAgentTemplate: (basePath: string, name: string, isSource: boolean, projectPath?: string) =>
      ipcRenderer.invoke(IPC.AGENT.CREATE_AGENT_TEMPLATE, basePath, name, isSource, projectPath),
    readPermissions: (worktreePath: string, projectPath?: string): Promise<{ allow?: string[]; deny?: string[] }> =>
      ipcRenderer.invoke(IPC.AGENT.READ_PERMISSIONS, worktreePath, projectPath),
    savePermissions: (worktreePath: string, permissions: { allow?: string[]; deny?: string[] }, projectPath?: string) =>
      ipcRenderer.invoke(IPC.AGENT.SAVE_PERMISSIONS, worktreePath, permissions, projectPath),
    readSkillContent: (worktreePath: string, skillName: string, projectPath?: string): Promise<string> =>
      ipcRenderer.invoke(IPC.AGENT.READ_SKILL_CONTENT, worktreePath, skillName, projectPath),
    writeSkillContent: (worktreePath: string, skillName: string, content: string, projectPath?: string) =>
      ipcRenderer.invoke(IPC.AGENT.WRITE_SKILL_CONTENT, worktreePath, skillName, content, projectPath),
    deleteSkill: (worktreePath: string, skillName: string, projectPath?: string) =>
      ipcRenderer.invoke(IPC.AGENT.DELETE_SKILL, worktreePath, skillName, projectPath),
    readAgentTemplateContent: (worktreePath: string, agentName: string, projectPath?: string): Promise<string> =>
      ipcRenderer.invoke(IPC.AGENT.READ_AGENT_TEMPLATE_CONTENT, worktreePath, agentName, projectPath),
    writeAgentTemplateContent: (worktreePath: string, agentName: string, content: string, projectPath?: string) =>
      ipcRenderer.invoke(IPC.AGENT.WRITE_AGENT_TEMPLATE_CONTENT, worktreePath, agentName, content, projectPath),
    deleteAgentTemplate: (worktreePath: string, agentName: string, projectPath?: string) =>
      ipcRenderer.invoke(IPC.AGENT.DELETE_AGENT_TEMPLATE, worktreePath, agentName, projectPath),
    listAgentTemplateFiles: (worktreePath: string, projectPath?: string) =>
      ipcRenderer.invoke(IPC.AGENT.LIST_AGENT_TEMPLATE_FILES, worktreePath, projectPath),
    readMcpRawJson: (worktreePath: string, projectPath?: string): Promise<string> =>
      ipcRenderer.invoke(IPC.AGENT.READ_MCP_RAW_JSON, worktreePath, projectPath),
    writeMcpRawJson: (worktreePath: string, content: string, projectPath?: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.AGENT.WRITE_MCP_RAW_JSON, worktreePath, content, projectPath),
    readProjectAgentDefaults: (projectPath: string): Promise<{
      instructions?: string;
      permissions?: { allow?: string[]; deny?: string[] };
      mcpJson?: string;
      freeAgentMode?: boolean;
    }> =>
      ipcRenderer.invoke(IPC.AGENT.READ_PROJECT_AGENT_DEFAULTS, projectPath),
    writeProjectAgentDefaults: (projectPath: string, defaults: {
      instructions?: string;
      permissions?: { allow?: string[]; deny?: string[] };
      mcpJson?: string;
      freeAgentMode?: boolean;
    }) =>
      ipcRenderer.invoke(IPC.AGENT.WRITE_PROJECT_AGENT_DEFAULTS, projectPath, defaults),
    getConventions: (projectPath: string): Promise<{
      configDir: string;
      localInstructionsFile: string;
      legacyInstructionsFile: string;
      mcpConfigFile: string;
      skillsDir: string;
      agentTemplatesDir: string;
      localSettingsFile: string;
    } | null> =>
      ipcRenderer.invoke(IPC.AGENT.GET_CONVENTIONS, projectPath),
    materializeAgent: (projectPath: string, agentId: string) =>
      ipcRenderer.invoke(IPC.AGENT.MATERIALIZE_AGENT, projectPath, agentId),
    previewMaterialization: (projectPath: string, agentId: string): Promise<{
      instructions: string;
      permissions: { allow?: string[]; deny?: string[] };
      mcpJson: string | null;
      skills: string[];
      agentTemplates: string[];
    } | null> =>
      ipcRenderer.invoke(IPC.AGENT.PREVIEW_MATERIALIZATION, projectPath, agentId),
  },
  file: {
    readTree: (dirPath: string, options?: { includeHidden?: boolean; depth?: number }) => ipcRenderer.invoke(IPC.FILE.READ_TREE, dirPath, options),
    read: (filePath: string) => ipcRenderer.invoke(IPC.FILE.READ, filePath),
    readBinary: (filePath: string) => ipcRenderer.invoke(IPC.FILE.READ_BINARY, filePath),
    write: (filePath: string, content: string) =>
      ipcRenderer.invoke(IPC.FILE.WRITE, filePath, content),
    showInFolder: (filePath: string) =>
      ipcRenderer.invoke(IPC.FILE.SHOW_IN_FOLDER, filePath),
    mkdir: (dirPath: string) =>
      ipcRenderer.invoke(IPC.FILE.MKDIR, dirPath),
    delete: (filePath: string) =>
      ipcRenderer.invoke(IPC.FILE.DELETE, filePath),
    rename: (oldPath: string, newPath: string) =>
      ipcRenderer.invoke(IPC.FILE.RENAME, oldPath, newPath),
    copy: (src: string, dest: string) =>
      ipcRenderer.invoke(IPC.FILE.COPY, src, dest),
    stat: (filePath: string) =>
      ipcRenderer.invoke(IPC.FILE.STAT, filePath),
  },
  plugin: {
    discoverCommunity: () =>
      ipcRenderer.invoke(IPC.PLUGIN.DISCOVER_COMMUNITY),
    storageRead: (req: { pluginId: string; scope: string; key: string; projectPath?: string }) =>
      ipcRenderer.invoke(IPC.PLUGIN.STORAGE_READ, req),
    storageWrite: (req: { pluginId: string; scope: string; key: string; value: unknown; projectPath?: string }) =>
      ipcRenderer.invoke(IPC.PLUGIN.STORAGE_WRITE, req),
    storageDelete: (req: { pluginId: string; scope: string; key: string; projectPath?: string }) =>
      ipcRenderer.invoke(IPC.PLUGIN.STORAGE_DELETE, req),
    storageList: (req: { pluginId: string; scope: string; projectPath?: string }) =>
      ipcRenderer.invoke(IPC.PLUGIN.STORAGE_LIST, req),
    fileRead: (req: { pluginId: string; scope: string; relativePath: string; projectPath?: string }) =>
      ipcRenderer.invoke(IPC.PLUGIN.FILE_READ, req),
    fileWrite: (req: { pluginId: string; scope: string; relativePath: string; content: string; projectPath?: string }) =>
      ipcRenderer.invoke(IPC.PLUGIN.FILE_WRITE, req),
    fileDelete: (req: { pluginId: string; scope: string; relativePath: string; projectPath?: string }) =>
      ipcRenderer.invoke(IPC.PLUGIN.FILE_DELETE, req),
    fileExists: (req: { pluginId: string; scope: string; relativePath: string; projectPath?: string }) =>
      ipcRenderer.invoke(IPC.PLUGIN.FILE_EXISTS, req),
    fileListDir: (req: { pluginId: string; scope: string; relativePath: string; projectPath?: string }) =>
      ipcRenderer.invoke(IPC.PLUGIN.FILE_LIST_DIR, req),
    gitignoreAdd: (projectPath: string, pluginId: string, patterns: string[]) =>
      ipcRenderer.invoke(IPC.PLUGIN.GITIGNORE_ADD, projectPath, pluginId, patterns),
    gitignoreRemove: (projectPath: string, pluginId: string) =>
      ipcRenderer.invoke(IPC.PLUGIN.GITIGNORE_REMOVE, projectPath, pluginId),
    gitignoreCheck: (projectPath: string, pattern: string) =>
      ipcRenderer.invoke(IPC.PLUGIN.GITIGNORE_CHECK, projectPath, pattern),
    startupMarkerRead: () =>
      ipcRenderer.invoke(IPC.PLUGIN.STARTUP_MARKER_READ),
    startupMarkerWrite: (enabledPlugins: string[]) =>
      ipcRenderer.invoke(IPC.PLUGIN.STARTUP_MARKER_WRITE, enabledPlugins),
    startupMarkerClear: () =>
      ipcRenderer.invoke(IPC.PLUGIN.STARTUP_MARKER_CLEAR),
    mkdir: (pluginId: string, scope: string, relativePath: string, projectPath?: string) =>
      ipcRenderer.invoke(IPC.PLUGIN.MKDIR, pluginId, scope, relativePath, projectPath),
    uninstall: (pluginId: string) =>
      ipcRenderer.invoke(IPC.PLUGIN.UNINSTALL, pluginId),
  },
  log: {
    write: (entry: { ts: string; ns: string; level: string; msg: string; projectId?: string; meta?: Record<string, unknown> }) =>
      ipcRenderer.send(IPC.LOG.LOG_WRITE, entry),
    getSettings: () =>
      ipcRenderer.invoke(IPC.LOG.GET_LOG_SETTINGS),
    saveSettings: (settings: { enabled: boolean; namespaces: Record<string, boolean>; retention: string; minLogLevel: string }) =>
      ipcRenderer.invoke(IPC.LOG.SAVE_LOG_SETTINGS, settings),
    getNamespaces: (): Promise<string[]> =>
      ipcRenderer.invoke(IPC.LOG.GET_LOG_NAMESPACES),
    getPath: (): Promise<string> =>
      ipcRenderer.invoke(IPC.LOG.GET_LOG_PATH),
  },
  process: {
    exec: (req: {
      pluginId: string;
      command: string;
      args: string[];
      allowedCommands: string[];
      projectPath: string;
      options?: { timeout?: number };
    }) => ipcRenderer.invoke(IPC.PROCESS.EXEC, req),
  },
  app: {
    openExternalUrl: (url: string) =>
      ipcRenderer.invoke(IPC.APP.OPEN_EXTERNAL_URL, url),
    getNotificationSettings: () =>
      ipcRenderer.invoke(IPC.APP.GET_NOTIFICATION_SETTINGS),
    saveNotificationSettings: (settings: any) =>
      ipcRenderer.invoke(IPC.APP.SAVE_NOTIFICATION_SETTINGS, settings),
    sendNotification: (title: string, body: string, silent: boolean, agentId?: string, projectId?: string) =>
      ipcRenderer.invoke(IPC.APP.SEND_NOTIFICATION, title, body, silent, agentId, projectId),
    closeNotification: (agentId: string, projectId: string) =>
      ipcRenderer.invoke(IPC.APP.CLOSE_NOTIFICATION, agentId, projectId),
    onNotificationClicked: (callback: (agentId: string, projectId: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, agentId: string, projectId: string) =>
        callback(agentId, projectId);
      ipcRenderer.on(IPC.APP.NOTIFICATION_CLICKED, listener);
      return () => { ipcRenderer.removeListener(IPC.APP.NOTIFICATION_CLICKED, listener); };
    },
    onOpenSettings: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on(IPC.APP.OPEN_SETTINGS, listener);
      return () => { ipcRenderer.removeListener(IPC.APP.OPEN_SETTINGS, listener); };
    },
    onOpenAbout: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on(IPC.APP.OPEN_ABOUT, listener);
      return () => { ipcRenderer.removeListener(IPC.APP.OPEN_ABOUT, listener); };
    },
    getTheme: () =>
      ipcRenderer.invoke(IPC.APP.GET_THEME),
    saveTheme: (settings: { themeId: string }) =>
      ipcRenderer.invoke(IPC.APP.SAVE_THEME, settings),
    updateTitleBarOverlay: (colors: { color: string; symbolColor: string }) =>
      ipcRenderer.invoke(IPC.APP.UPDATE_TITLE_BAR_OVERLAY, colors),
    getOrchestratorSettings: () =>
      ipcRenderer.invoke(IPC.APP.GET_ORCHESTRATOR_SETTINGS),
    saveOrchestratorSettings: (settings: { enabled: string[] }) =>
      ipcRenderer.invoke(IPC.APP.SAVE_ORCHESTRATOR_SETTINGS, settings),
    getVersion: (): Promise<string> =>
      ipcRenderer.invoke(IPC.APP.GET_VERSION),
    getArchInfo: (): Promise<{ arch: string; platform: string; rosetta: boolean }> =>
      ipcRenderer.invoke(IPC.APP.GET_ARCH_INFO),
    getHeadlessSettings: () =>
      ipcRenderer.invoke(IPC.APP.GET_HEADLESS_SETTINGS),
    saveHeadlessSettings: (settings: { enabled: boolean; projectOverrides?: Record<string, string> }) =>
      ipcRenderer.invoke(IPC.APP.SAVE_HEADLESS_SETTINGS, settings),
    setDockBadge: (count: number) =>
      ipcRenderer.invoke(IPC.APP.SET_DOCK_BADGE, count),
    getBadgeSettings: () =>
      ipcRenderer.invoke(IPC.APP.GET_BADGE_SETTINGS),
    saveBadgeSettings: (settings: any) =>
      ipcRenderer.invoke(IPC.APP.SAVE_BADGE_SETTINGS, settings),
    getUpdateSettings: () =>
      ipcRenderer.invoke(IPC.APP.GET_UPDATE_SETTINGS),
    saveUpdateSettings: (settings: { autoUpdate: boolean; lastCheck: string | null; dismissedVersion: string | null; lastSeenVersion: string | null }) =>
      ipcRenderer.invoke(IPC.APP.SAVE_UPDATE_SETTINGS, settings),
    checkForUpdates: () =>
      ipcRenderer.invoke(IPC.APP.CHECK_FOR_UPDATES),
    getUpdateStatus: () =>
      ipcRenderer.invoke(IPC.APP.GET_UPDATE_STATUS),
    applyUpdate: () =>
      ipcRenderer.invoke(IPC.APP.APPLY_UPDATE),
    getPendingReleaseNotes: () =>
      ipcRenderer.invoke(IPC.APP.GET_PENDING_RELEASE_NOTES),
    clearPendingReleaseNotes: () =>
      ipcRenderer.invoke(IPC.APP.CLEAR_PENDING_RELEASE_NOTES),
    getVersionHistory: () =>
      ipcRenderer.invoke(IPC.APP.GET_VERSION_HISTORY),
    getClubhouseModeSettings: () =>
      ipcRenderer.invoke(IPC.APP.GET_CLUBHOUSE_MODE_SETTINGS),
    saveClubhouseModeSettings: (settings: { enabled: boolean; projectOverrides?: Record<string, boolean> }, projectPath?: string) =>
      ipcRenderer.invoke(IPC.APP.SAVE_CLUBHOUSE_MODE_SETTINGS, settings, projectPath),
    onUpdateStatusChanged: (callback: (status: {
      state: string;
      availableVersion: string | null;
      releaseNotes: string | null;
      releaseMessage: string | null;
      downloadProgress: number;
      error: string | null;
      downloadPath: string | null;
    }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, s: any) => callback(s);
      ipcRenderer.on(IPC.APP.UPDATE_STATUS_CHANGED, listener);
      return () => { ipcRenderer.removeListener(IPC.APP.UPDATE_STATUS_CHANGED, listener); };
    },
  },
};

export type ClubhouseAPI = typeof api;

contextBridge.exposeInMainWorld('clubhouse', api);
