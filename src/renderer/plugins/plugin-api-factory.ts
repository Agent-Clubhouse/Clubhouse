import React from 'react';
import type {
  PluginContext,
  PluginAPI,
  ProjectAPI,
  ProjectsAPI,
  GitAPI,
  StorageAPI,
  ScopedStorage,
  UIAPI,
  CommandsAPI,
  EventsAPI,
  SettingsAPI,
  AgentsAPI,
  HubAPI,
  NavigationAPI,
  WidgetsAPI,
  TerminalAPI,
  LoggingAPI,
  FilesAPI,
  PluginContextInfo,
  PluginRenderMode,
  DirectoryEntry,
  GitStatus,
  GitCommit,
  ProjectInfo,
  AgentInfo,
  PluginAgentDetailedStatus,
  CompletedQuickAgentInfo,
  ModelOption,
  Disposable,
} from '../../shared/plugin-types';
import { rendererLog } from './renderer-logger';
import { pluginEventBus } from './plugin-events';
import { pluginCommandRegistry } from './plugin-commands';
import { usePluginStore } from './plugin-store';
import { useProjectStore } from '../stores/projectStore';
import { useAgentStore } from '../stores/agentStore';
import { useQuickAgentStore } from '../stores/quickAgentStore';
import { useUIStore } from '../stores/uiStore';

function unavailableProxy(apiName: string, scope: string): never {
  throw new Error(`api.${apiName} is not available for ${scope}-scoped plugins`);
}

function createScopedStorage(pluginId: string, storageScope: 'project' | 'project-local' | 'global', projectPath?: string): ScopedStorage {
  return {
    async read(key: string): Promise<unknown> {
      return window.clubhouse.plugin.storageRead({ pluginId, scope: storageScope, key, projectPath });
    },
    async write(key: string, value: unknown): Promise<void> {
      await window.clubhouse.plugin.storageWrite({ pluginId, scope: storageScope, key, value, projectPath });
    },
    async delete(key: string): Promise<void> {
      await window.clubhouse.plugin.storageDelete({ pluginId, scope: storageScope, key, projectPath });
    },
    async list(): Promise<string[]> {
      return window.clubhouse.plugin.storageList({ pluginId, scope: storageScope, projectPath });
    },
  };
}

function createProjectAPI(ctx: PluginContext): ProjectAPI {
  const { projectPath, projectId } = ctx;
  if (!projectPath || !projectId) {
    throw new Error('ProjectAPI requires projectPath and projectId');
  }

  return {
    projectPath,
    projectId,
    async readFile(relativePath: string): Promise<string> {
      const fullPath = `${projectPath}/${relativePath}`;
      return window.clubhouse.file.read(fullPath);
    },
    async writeFile(relativePath: string, content: string): Promise<void> {
      const fullPath = `${projectPath}/${relativePath}`;
      await window.clubhouse.file.write(fullPath, content);
    },
    async deleteFile(relativePath: string): Promise<void> {
      const fullPath = `${projectPath}/${relativePath}`;
      await window.clubhouse.file.delete(fullPath);
    },
    async fileExists(relativePath: string): Promise<boolean> {
      try {
        const fullPath = `${projectPath}/${relativePath}`;
        await window.clubhouse.file.read(fullPath);
        return true;
      } catch {
        return false;
      }
    },
    async listDirectory(relativePath = '.'): Promise<DirectoryEntry[]> {
      const fullPath = `${projectPath}/${relativePath}`;
      const tree = await window.clubhouse.file.readTree(fullPath);
      return tree.map((node: { name: string; path: string; isDirectory: boolean }) => ({
        name: node.name,
        path: node.path,
        isDirectory: node.isDirectory,
      }));
    },
  };
}

function createProjectsAPI(): ProjectsAPI {
  return {
    list(): ProjectInfo[] {
      return useProjectStore.getState().projects.map((p) => ({
        id: p.id,
        name: p.displayName || p.name,
        path: p.path,
      }));
    },
    getActive(): ProjectInfo | null {
      const store = useProjectStore.getState();
      const project = store.projects.find((p) => p.id === store.activeProjectId);
      if (!project) return null;
      return { id: project.id, name: project.displayName || project.name, path: project.path };
    },
  };
}

function createGitAPI(ctx: PluginContext): GitAPI {
  const { projectPath } = ctx;
  if (!projectPath) {
    throw new Error('GitAPI requires projectPath');
  }

  return {
    async status(): Promise<GitStatus[]> {
      const info = await window.clubhouse.git.info(projectPath);
      return info.status.map((s: { path: string; status: string; staged: boolean }) => ({
        path: s.path,
        status: s.status,
        staged: s.staged,
      }));
    },
    async log(limit = 20): Promise<GitCommit[]> {
      const info = await window.clubhouse.git.info(projectPath);
      return info.log.slice(0, limit).map((e: { hash: string; shortHash: string; subject: string; author: string; date: string }) => ({
        hash: e.hash,
        shortHash: e.shortHash,
        subject: e.subject,
        author: e.author,
        date: e.date,
      }));
    },
    async currentBranch(): Promise<string> {
      const info = await window.clubhouse.git.info(projectPath);
      return info.branch;
    },
    async diff(filePath: string, staged = false): Promise<string> {
      return window.clubhouse.git.diff(projectPath, filePath, staged);
    },
  };
}

function createStorageAPI(ctx: PluginContext): StorageAPI {
  return {
    project: createScopedStorage(ctx.pluginId, 'project', ctx.projectPath),
    projectLocal: createScopedStorage(ctx.pluginId, 'project-local', ctx.projectPath),
    global: createScopedStorage(ctx.pluginId, 'global'),
  };
}

function createUIAPI(): UIAPI {
  return {
    showNotice(message: string): void {
      // Simple notification using existing notification system
      console.log(`[Plugin Notice] ${message}`);
    },
    showError(message: string): void {
      console.error(`[Plugin Error] ${message}`);
    },
    async showConfirm(message: string): Promise<boolean> {
      return window.confirm(message);
    },
    async showInput(prompt: string, defaultValue = ''): Promise<string | null> {
      return window.prompt(prompt, defaultValue);
    },
  };
}

function createCommandsAPI(ctx: PluginContext): CommandsAPI {
  return {
    register(commandId: string, handler: (...args: unknown[]) => void | Promise<void>): Disposable {
      const fullId = `${ctx.pluginId}:${commandId}`;
      return pluginCommandRegistry.register(fullId, handler);
    },
    async execute(commandId: string, ...args: unknown[]): Promise<void> {
      // Try with plugin prefix first, then raw
      const fullId = `${ctx.pluginId}:${commandId}`;
      if (pluginCommandRegistry.has(fullId)) {
        await pluginCommandRegistry.execute(fullId, ...args);
      } else {
        await pluginCommandRegistry.execute(commandId, ...args);
      }
    },
  };
}

function createEventsAPI(): EventsAPI {
  return {
    on(event: string, handler: (...args: unknown[]) => void): Disposable {
      return pluginEventBus.on(event, handler);
    },
  };
}

function createSettingsAPI(ctx: PluginContext): SettingsAPI {
  const settingsKey = (ctx.scope === 'project' || ctx.scope === 'dual') && ctx.projectId
    ? `${ctx.projectId}:${ctx.pluginId}`
    : `app:${ctx.pluginId}`;
  const changeHandlers = new Set<(key: string, value: unknown) => void>();

  return {
    get<T = unknown>(key: string): T | undefined {
      const allSettings = usePluginStore.getState().pluginSettings[settingsKey];
      return allSettings?.[key] as T | undefined;
    },
    getAll(): Record<string, unknown> {
      return usePluginStore.getState().pluginSettings[settingsKey] || {};
    },
    onChange(callback: (key: string, value: unknown) => void): Disposable {
      changeHandlers.add(callback);
      return {
        dispose: () => { changeHandlers.delete(callback); },
      };
    },
  };
}

function createAgentsAPI(ctx: PluginContext): AgentsAPI {
  return {
    list(): AgentInfo[] {
      const agents = useAgentStore.getState().agents;
      return Object.values(agents)
        .filter((a) => !ctx.projectId || a.projectId === ctx.projectId)
        .map((a) => ({
          id: a.id,
          name: a.name,
          kind: a.kind,
          status: a.status,
          color: a.color,
          emoji: a.emoji,
          exitCode: a.exitCode,
          mission: a.mission,
          projectId: a.projectId,
          branch: a.branch,
          model: a.model,
          parentAgentId: a.parentAgentId,
        }));
    },

    async runQuick(mission: string, options?: { model?: string; systemPrompt?: string; projectId?: string }): Promise<string> {
      let projectId = ctx.projectId;
      let projectPath = ctx.projectPath;

      if (options?.projectId) {
        const project = useProjectStore.getState().projects.find((p) => p.id === options.projectId);
        if (!project) throw new Error(`Project not found: ${options.projectId}`);
        projectId = project.id;
        projectPath = project.path;
      }

      if (!projectId || !projectPath) {
        throw new Error('runQuick requires a project context');
      }
      return useAgentStore.getState().spawnQuickAgent(
        projectId,
        projectPath,
        mission,
        options?.model,
      );
    },

    async kill(agentId: string): Promise<void> {
      const agent = useAgentStore.getState().agents[agentId];
      if (!agent) return;
      const project = useProjectStore.getState().projects.find((p) => p.id === agent.projectId);
      await useAgentStore.getState().killAgent(agentId, project?.path);
    },

    async resume(agentId: string): Promise<void> {
      const agent = useAgentStore.getState().agents[agentId];
      if (!agent || agent.kind !== 'durable') {
        throw new Error('Can only resume durable agents');
      }
      const project = useProjectStore.getState().projects.find((p) => p.id === agent.projectId);
      if (!project) throw new Error('Project not found for agent');
      const configs = await window.clubhouse.agent.listDurable(project.path);
      const config = configs.find((c: { id: string }) => c.id === agentId);
      if (!config) throw new Error('Durable config not found for agent');
      await useAgentStore.getState().spawnDurableAgent(project.id, project.path, config, true);
    },

    listCompleted(projectId?: string): CompletedQuickAgentInfo[] {
      const pid = projectId || ctx.projectId;
      if (!pid) return [];
      const records = useQuickAgentStore.getState().completedAgents[pid] || [];
      return records.map((r) => ({
        id: r.id,
        projectId: r.projectId,
        name: r.name,
        mission: r.mission,
        summary: r.summary,
        filesModified: r.filesModified,
        exitCode: r.exitCode,
        completedAt: r.completedAt,
        parentAgentId: r.parentAgentId,
      }));
    },

    dismissCompleted(projectId: string, agentId: string): void {
      useQuickAgentStore.getState().dismissCompleted(projectId, agentId);
    },

    getDetailedStatus(agentId: string): PluginAgentDetailedStatus | null {
      const status = useAgentStore.getState().agentDetailedStatus[agentId];
      if (!status) return null;
      return {
        state: status.state,
        message: status.message,
        toolName: status.toolName,
      };
    },

    async getModelOptions(projectId?: string): Promise<ModelOption[]> {
      const DEFAULT_OPTIONS: ModelOption[] = [
        { id: 'default', label: 'Default' },
        { id: 'opus', label: 'Opus' },
        { id: 'sonnet', label: 'Sonnet' },
        { id: 'haiku', label: 'Haiku' },
      ];
      const pid = projectId || ctx.projectId;
      if (!pid) return DEFAULT_OPTIONS;
      const project = useProjectStore.getState().projects.find((p) => p.id === pid);
      if (!project) return DEFAULT_OPTIONS;
      try {
        const result = await window.clubhouse.agent.getModelOptions(project.path);
        if (Array.isArray(result) && result.length > 0) return result;
        return DEFAULT_OPTIONS;
      } catch {
        return DEFAULT_OPTIONS;
      }
    },

    onStatusChange(callback: (agentId: string, status: string, prevStatus: string) => void): Disposable {
      let prevStatuses: Record<string, string> = {};
      // Snapshot current state
      const agents = useAgentStore.getState().agents;
      for (const [id, agent] of Object.entries(agents)) {
        prevStatuses[id] = agent.status;
      }

      const unsub = useAgentStore.subscribe((state) => {
        const currentAgents = state.agents;
        for (const [id, agent] of Object.entries(currentAgents)) {
          const prev = prevStatuses[id];
          if (prev && prev !== agent.status) {
            callback(id, agent.status, prev);
          }
        }
        // Update snapshot
        const next: Record<string, string> = {};
        for (const [id, agent] of Object.entries(currentAgents)) {
          next[id] = agent.status;
        }
        prevStatuses = next;
      });

      return { dispose: unsub };
    },

    onAnyChange(callback: () => void): Disposable {
      const unsub = useAgentStore.subscribe(callback);
      return { dispose: unsub };
    },
  };
}

function createHubAPI(): HubAPI {
  return {
    refresh(): void {
      // Placeholder — hub refresh will be wired when hub store is available
    },
  };
}

function createNavigationAPI(): NavigationAPI {
  return {
    focusAgent(agentId: string): void {
      useUIStore.getState().setExplorerTab('agents');
      useAgentStore.getState().setActiveAgent(agentId);
    },
    setExplorerTab(tabId: string): void {
      useUIStore.getState().setExplorerTab(tabId);
    },
  };
}

let _widgetsCache: WidgetsAPI | null = null;

function createWidgetsAPI(): WidgetsAPI {
  if (_widgetsCache) return _widgetsCache;

  // Lazy imports to avoid circular deps — these are only needed when a plugin renders widgets.
  // Wrapped in try/catch for test environments where these modules may not be available.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let AgentTerminalComponent: React.ComponentType<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let SleepingAgentComponent: React.ComponentType<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let AgentAvatarComponent: React.ComponentType<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let QuickAgentGhostComponent: React.ComponentType<any>;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let AgentAvatarWithRingComponent: React.ComponentType<any>;

  try {
    AgentTerminalComponent = require('../features/agents/AgentTerminal').AgentTerminal;
    SleepingAgentComponent = require('../features/agents/SleepingAgent').SleepingAgent;
    AgentAvatarComponent = require('../features/agents/AgentAvatar').AgentAvatar;
    AgentAvatarWithRingComponent = require('../features/agents/AgentAvatar').AgentAvatarWithRing;
    QuickAgentGhostComponent = require('../features/agents/QuickAgentGhost').QuickAgentGhost;
  } catch {
    // In test environments, return stub components
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stub = ((): null => null) as unknown as React.ComponentType<any>;
    _widgetsCache = {
      AgentTerminal: stub,
      SleepingAgent: stub,
      AgentAvatar: stub,
      QuickAgentGhost: stub,
    };
    return _widgetsCache;
  }

  // SleepingAgent adapter: plugin passes agentId, we resolve to Agent reactively
  const SleepingAgentAdapter = ({ agentId }: { agentId: string }) => {
    const agent = useAgentStore((s) => s.agents[agentId]);
    if (!agent) return null;
    return React.createElement(SleepingAgentComponent, { agent });
  };

  // AgentAvatar adapter: when showStatusRing is true, use the ring variant with status colors
  const AgentAvatarAdapter = ({ agentId, size, showStatusRing }: { agentId: string; size?: 'sm' | 'md'; showStatusRing?: boolean }) => {
    const agent = useAgentStore((s) => s.agents[agentId]);
    if (!agent) return null;
    if (showStatusRing && AgentAvatarWithRingComponent) {
      return React.createElement(AgentAvatarWithRingComponent, { agent });
    }
    return React.createElement(AgentAvatarComponent, { agent, size });
  };

  _widgetsCache = {
    AgentTerminal: AgentTerminalComponent,
    SleepingAgent: SleepingAgentAdapter,
    AgentAvatar: AgentAvatarAdapter,
    QuickAgentGhost: QuickAgentGhostComponent,
  };
  return _widgetsCache;
}

function createTerminalAPI(ctx: PluginContext): TerminalAPI {
  const prefix = `plugin:${ctx.pluginId}:`;

  function fullId(sessionId: string): string {
    return `${prefix}${sessionId}`;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ShellTerminalComponent: React.ComponentType<any> | null = null;

  try {
    ShellTerminalComponent = require('../features/terminal/ShellTerminal').ShellTerminal;
  } catch {
    // Test environment — return stub
  }

  const ShellTerminalWidget = ({ sessionId, focused }: { sessionId: string; focused?: boolean }) => {
    if (!ShellTerminalComponent) return null;
    return React.createElement(ShellTerminalComponent, { sessionId: fullId(sessionId), focused });
  };

  return {
    async spawn(sessionId: string, cwd?: string): Promise<void> {
      const dir = cwd || ctx.projectPath;
      if (!dir) throw new Error('terminal.spawn requires a working directory (cwd or project context)');
      await window.clubhouse.pty.spawnShell(fullId(sessionId), dir);
    },
    write(sessionId: string, data: string): void {
      window.clubhouse.pty.write(fullId(sessionId), data);
    },
    resize(sessionId: string, cols: number, rows: number): void {
      window.clubhouse.pty.resize(fullId(sessionId), cols, rows);
    },
    async kill(sessionId: string): Promise<void> {
      await window.clubhouse.pty.kill(fullId(sessionId));
    },
    async getBuffer(sessionId: string): Promise<string> {
      return window.clubhouse.pty.getBuffer(fullId(sessionId));
    },
    onData(sessionId: string, callback: (data: string) => void): Disposable {
      const fid = fullId(sessionId);
      const remove = window.clubhouse.pty.onData((id: string, data: string) => {
        if (id === fid) callback(data);
      });
      return { dispose: remove };
    },
    onExit(sessionId: string, callback: (exitCode: number) => void): Disposable {
      const fid = fullId(sessionId);
      const remove = window.clubhouse.pty.onExit((id: string, exitCode: number) => {
        if (id === fid) callback(exitCode);
      });
      return { dispose: remove };
    },
    ShellTerminal: ShellTerminalWidget,
  };
}

function createLoggingAPI(ctx: PluginContext): LoggingAPI {
  const ns = `plugin:${ctx.pluginId}`;
  return {
    debug(msg: string, meta?: Record<string, unknown>): void {
      rendererLog(ns, 'debug', msg, { projectId: ctx.projectId, meta });
    },
    info(msg: string, meta?: Record<string, unknown>): void {
      rendererLog(ns, 'info', msg, { projectId: ctx.projectId, meta });
    },
    warn(msg: string, meta?: Record<string, unknown>): void {
      rendererLog(ns, 'warn', msg, { projectId: ctx.projectId, meta });
    },
    error(msg: string, meta?: Record<string, unknown>): void {
      rendererLog(ns, 'error', msg, { projectId: ctx.projectId, meta });
    },
    fatal(msg: string, meta?: Record<string, unknown>): void {
      rendererLog(ns, 'fatal', msg, { projectId: ctx.projectId, meta });
    },
  };
}

function resolvePath(projectPath: string, relativePath: string): string {
  // Normalize: join project path with relative path, then check for traversal
  const resolved = relativePath.startsWith('/')
    ? relativePath
    : `${projectPath}/${relativePath}`;

  // Simple traversal check: resolved must start with projectPath
  // Normalize double slashes and resolve .. manually
  const normalizedProject = projectPath.replace(/\/+$/, '');
  const normalizedResolved = resolved.replace(/\/+/g, '/');

  // Check for path traversal via ..
  if (normalizedResolved.includes('/../') || normalizedResolved.endsWith('/..') || normalizedResolved === '..') {
    throw new Error('Path traversal is not allowed');
  }

  if (!normalizedResolved.startsWith(normalizedProject + '/') && normalizedResolved !== normalizedProject) {
    throw new Error('Path traversal is not allowed');
  }

  return normalizedResolved;
}

function createFilesAPI(ctx: PluginContext): FilesAPI {
  const { projectPath } = ctx;
  if (!projectPath) {
    throw new Error('FilesAPI requires projectPath');
  }

  return {
    async readTree(relativePath = '.', options?: { includeHidden?: boolean; depth?: number }) {
      const fullPath = resolvePath(projectPath, relativePath);
      return window.clubhouse.file.readTree(fullPath, options);
    },
    async readFile(relativePath: string) {
      const fullPath = resolvePath(projectPath, relativePath);
      return window.clubhouse.file.read(fullPath);
    },
    async readBinary(relativePath: string) {
      const fullPath = resolvePath(projectPath, relativePath);
      return window.clubhouse.file.readBinary(fullPath);
    },
    async writeFile(relativePath: string, content: string) {
      const fullPath = resolvePath(projectPath, relativePath);
      await window.clubhouse.file.write(fullPath, content);
    },
    async stat(relativePath: string) {
      const fullPath = resolvePath(projectPath, relativePath);
      return window.clubhouse.file.stat(fullPath);
    },
    async rename(oldRelativePath: string, newRelativePath: string) {
      const oldFull = resolvePath(projectPath, oldRelativePath);
      const newFull = resolvePath(projectPath, newRelativePath);
      await window.clubhouse.file.rename(oldFull, newFull);
    },
    async copy(srcRelativePath: string, destRelativePath: string) {
      const srcFull = resolvePath(projectPath, srcRelativePath);
      const destFull = resolvePath(projectPath, destRelativePath);
      await window.clubhouse.file.copy(srcFull, destFull);
    },
    async mkdir(relativePath: string) {
      const fullPath = resolvePath(projectPath, relativePath);
      await window.clubhouse.file.mkdir(fullPath);
    },
    async delete(relativePath: string) {
      const fullPath = resolvePath(projectPath, relativePath);
      await window.clubhouse.file.delete(fullPath);
    },
    async showInFolder(relativePath: string) {
      const fullPath = resolvePath(projectPath, relativePath);
      await window.clubhouse.file.showInFolder(fullPath);
    },
  };
}

export function createPluginAPI(ctx: PluginContext, mode?: PluginRenderMode): PluginAPI {
  const effectiveMode = mode || (ctx.scope === 'app' ? 'app' : 'project');
  const hasProjectContext = effectiveMode === 'project' && !!ctx.projectId;
  const isDual = ctx.scope === 'dual';

  // For dual-scope plugins, project API is available only in project mode
  const projectAvailable = ctx.scope === 'project' || (isDual && effectiveMode === 'project');
  // For dual-scope plugins, projects API is always available; for single scope it depends
  const projectsAvailable = ctx.scope === 'app' || isDual;

  const contextInfo: PluginContextInfo = {
    mode: effectiveMode,
    projectId: ctx.projectId,
    projectPath: ctx.projectPath,
  };

  const api: PluginAPI = {
    project: projectAvailable && ctx.projectPath && ctx.projectId
      ? createProjectAPI(ctx)
      : new Proxy({} as ProjectAPI, {
          get(_t, _prop) { unavailableProxy('project', effectiveMode === 'app' ? 'app' : ctx.scope); },
        }),
    projects: projectsAvailable
      ? createProjectsAPI()
      : new Proxy({} as ProjectsAPI, {
          get(_t, _prop) { unavailableProxy('projects', 'project'); },
        }),
    git: projectAvailable && ctx.projectPath
      ? createGitAPI(ctx)
      : new Proxy({} as GitAPI, {
          get(_t, _prop) { unavailableProxy('git', effectiveMode === 'app' ? 'app' : ctx.scope); },
        }),
    storage: createStorageAPI(ctx),
    ui: createUIAPI(),
    commands: createCommandsAPI(ctx),
    events: createEventsAPI(),
    settings: createSettingsAPI(ctx),
    agents: createAgentsAPI(ctx),
    hub: createHubAPI(),
    navigation: createNavigationAPI(),
    widgets: createWidgetsAPI(),
    terminal: createTerminalAPI(ctx),
    logging: createLoggingAPI(ctx),
    files: projectAvailable && ctx.projectPath
      ? createFilesAPI(ctx)
      : new Proxy({} as FilesAPI, {
          get(_t, _prop) { unavailableProxy('files', effectiveMode === 'app' ? 'app' : ctx.scope); },
        }),
    context: contextInfo,
  };

  return api;
}
