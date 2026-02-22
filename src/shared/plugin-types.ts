import type { FileNode } from './types';

// ── Disposable ──────────────────────────────────────────────────────────
export interface Disposable {
  dispose(): void;
}

// ── Manifest types ─────────────────────────────────────────────────────
export interface PluginCommandDeclaration {
  id: string;
  title: string;
  /** Default keyboard binding (e.g. "Meta+Shift+L"). Only available in API >= 0.6. */
  defaultBinding?: string;
  /** When true, the hotkey fires even in text inputs. */
  global?: boolean;
}

export interface PluginSettingDeclaration {
  key: string;
  type: 'boolean' | 'string' | 'number' | 'select' | 'directory';
  label: string;
  description?: string;
  default?: unknown;
  options?: Array<{ label: string; value: string }>;  // for 'select' type
}

export interface PluginStorageDeclaration {
  scope: 'project' | 'project-local' | 'global';
}

// ── Permission system (v0.5+) ──────────────────────────────────────────
export type PluginPermission =
  | 'files'
  | 'files.external'
  | 'git'
  | 'terminal'
  | 'agents'
  | 'notifications'
  | 'storage'
  | 'navigation'
  | 'projects'
  | 'commands'
  | 'events'
  | 'widgets'
  | 'logging'
  | 'process'
  | 'badges'
  | 'agent-config'
  | 'agent-config.cross-project'
  | 'agent-config.permissions'
  | 'agent-config.mcp';

export const ALL_PLUGIN_PERMISSIONS: readonly PluginPermission[] = [
  'files',
  'files.external',
  'git',
  'terminal',
  'agents',
  'notifications',
  'storage',
  'navigation',
  'projects',
  'commands',
  'events',
  'widgets',
  'logging',
  'process',
  'badges',
  'agent-config',
  'agent-config.cross-project',
  'agent-config.permissions',
  'agent-config.mcp',
] as const;

export interface PluginExternalRoot {
  settingKey: string;
  root: string;
}

export const PERMISSION_DESCRIPTIONS: Record<PluginPermission, string> = {
  files: 'Read and write files within the project directory',
  'files.external': 'Access files outside the project directory',
  git: 'Read git status, log, branch, and diffs',
  terminal: 'Spawn and control terminal sessions',
  agents: 'Spawn, monitor, and manage AI agents',
  notifications: 'Display notices, errors, and input prompts',
  storage: 'Store and retrieve persistent plugin data',
  navigation: 'Navigate the UI (focus agents, switch tabs)',
  projects: 'List and access other open projects',
  commands: 'Register and execute commands',
  events: 'Subscribe to the event bus',
  widgets: 'Use shared UI widget components',
  logging: 'Write to the application log',
  process: 'Execute allowed CLI commands',
  badges: 'Display badge indicators on tabs and rail items',
  'agent-config': 'Inject skills, agent templates, and instruction content into project agents',
  'agent-config.cross-project': 'Inject agent configuration into other projects where the plugin is also enabled (elevated)',
  'agent-config.permissions': 'Modify agent permission allow/deny rules (elevated)',
  'agent-config.mcp': 'Inject MCP server configurations into project agents (elevated)',
};

export interface PluginHelpTopic {
  id: string;
  title: string;
  content: string; // markdown
}

export interface PluginHelpContribution {
  topics?: PluginHelpTopic[];
}

export interface PluginContributes {
  tab?: {
    label: string;
    icon?: string;        // SVG string or icon name
    layout?: 'sidebar-content' | 'full';  // default: 'sidebar-content'
  };
  railItem?: {
    label: string;
    icon?: string;
    position?: 'top' | 'bottom';  // default: 'top'
  };
  commands?: PluginCommandDeclaration[];
  settings?: PluginSettingDeclaration[];
  storage?: PluginStorageDeclaration;
  help?: PluginHelpContribution;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  official?: boolean;
  engine: { api: number };
  scope: 'project' | 'app' | 'dual';
  main?: string;                     // path to main module relative to plugin dir
  contributes?: PluginContributes;
  settingsPanel?: 'declarative' | 'custom';
  permissions?: PluginPermission[];         // required for v0.5+
  externalRoots?: PluginExternalRoot[];     // requires 'files.external' permission
  allowedCommands?: string[];              // requires 'process' permission
}

// ── Render mode for dual-scope plugins ───────────────────────────────
export type PluginRenderMode = 'project' | 'app';

// ── Plugin status & registry ───────────────────────────────────────────
export type PluginStatus =
  | 'registered'
  | 'enabled'
  | 'activated'
  | 'deactivated'
  | 'disabled'
  | 'errored'
  | 'incompatible';

export type PluginSource = 'builtin' | 'community';

export interface PluginRegistryEntry {
  manifest: PluginManifest;
  status: PluginStatus;
  error?: string;
  source: PluginSource;
  pluginPath: string;
}

// ── Plugin context (per-activation) ────────────────────────────────────
export interface PluginContext {
  pluginId: string;
  pluginPath: string;
  scope: 'project' | 'app' | 'dual';
  projectId?: string;
  projectPath?: string;
  subscriptions: Disposable[];
  settings: Record<string, unknown>;
}

// ── Plugin module (what a plugin's main.js exports) ────────────────────
export interface PluginModule {
  activate?(ctx: PluginContext, api: PluginAPI): void | Promise<void>;
  deactivate?(): void | Promise<void>;
  MainPanel?: React.ComponentType<{ api: PluginAPI }>;
  SidebarPanel?: React.ComponentType<{ api: PluginAPI }>;
  HubPanel?: React.ComponentType<HubPanelProps>;
  SettingsPanel?: React.ComponentType<{ api: PluginAPI }>;
}

export interface HubPanelProps {
  paneId: string;
  resourceId?: string;
}

// ── Sub-API interfaces ─────────────────────────────────────────────────
export interface DirectoryEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface FileEvent {
  type: 'created' | 'modified' | 'deleted';
  path: string;
}

export interface GitStatus {
  path: string;
  status: string;
  staged: boolean;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  date: string;
}

export interface ProjectInfo {
  id: string;
  name: string;
  path: string;
}

export interface AgentInfo {
  id: string;
  name: string;
  kind: 'durable' | 'quick';
  status: 'running' | 'sleeping' | 'error';
  color: string;
  icon?: string;
  exitCode?: number;
  mission?: string;
  projectId: string;
  branch?: string;
  worktreePath?: string;
  model?: string;
  parentAgentId?: string;
}

export interface PluginAgentDetailedStatus {
  state: 'idle' | 'working' | 'needs_permission' | 'tool_error';
  message: string;
  toolName?: string;
}

export interface CompletedQuickAgentInfo {
  id: string;
  projectId: string;
  name: string;
  mission: string;
  summary: string | null;
  filesModified: string[];
  exitCode: number;
  completedAt: number;
  parentAgentId?: string;
}

export interface ScopedStorage {
  read(key: string): Promise<unknown>;
  write(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<string[]>;
}

export interface StorageAPI {
  /** Project-scoped, committed — .clubhouse/plugin-data/{pluginId}/ */
  project: ScopedStorage;
  /** Project-scoped, gitignored — .clubhouse/plugin-data-local/{pluginId}/ */
  projectLocal: ScopedStorage;
  /** Global (user home) — ~/.clubhouse/plugin-data/{pluginId}/ */
  global: ScopedStorage;
}

export interface ProjectAPI {
  readFile(relativePath: string): Promise<string>;
  writeFile(relativePath: string, content: string): Promise<void>;
  deleteFile(relativePath: string): Promise<void>;
  fileExists(relativePath: string): Promise<boolean>;
  listDirectory(relativePath?: string): Promise<DirectoryEntry[]>;
  readonly projectPath: string;
  readonly projectId: string;
}

export interface ProjectsAPI {
  list(): ProjectInfo[];
  getActive(): ProjectInfo | null;
}

export interface GitAPI {
  status(): Promise<GitStatus[]>;
  log(limit?: number): Promise<GitCommit[]>;
  currentBranch(): Promise<string>;
  diff(filePath: string, staged?: boolean): Promise<string>;
}

export interface UIAPI {
  showNotice(message: string): void;
  showError(message: string): void;
  showConfirm(message: string): Promise<boolean>;
  showInput(prompt: string, defaultValue?: string): Promise<string | null>;
  openExternalUrl(url: string): Promise<void>;
}

export interface CommandsAPI {
  register(commandId: string, handler: (...args: unknown[]) => void | Promise<void>): Disposable;
  execute(commandId: string, ...args: unknown[]): Promise<void>;
  /**
   * Register a command with a keyboard binding.
   * The binding follows the format "Meta+Shift+K".
   * On collision, the first claimer keeps the binding; later claims are unbound.
   * Returns a Disposable that unregisters both the command and its hotkey.
   */
  registerWithHotkey(
    commandId: string,
    title: string,
    handler: (...args: unknown[]) => void | Promise<void>,
    defaultBinding: string,
    options?: { global?: boolean },
  ): Disposable;
  /** Get the current keyboard binding for a plugin command (null if unbound). */
  getBinding(commandId: string): string | null;
  /** Clear the keyboard binding for a plugin command. */
  clearBinding(commandId: string): void;
}

export interface EventsAPI {
  on(event: string, handler: (...args: unknown[]) => void): Disposable;
}

export interface SettingsAPI {
  get<T = unknown>(key: string): T | undefined;
  getAll(): Record<string, unknown>;
  onChange(callback: (key: string, value: unknown) => void): Disposable;
}

export interface ModelOption {
  id: string;
  label: string;
}

export interface AgentsAPI {
  list(): AgentInfo[];
  runQuick(mission: string, options?: { model?: string; systemPrompt?: string; projectId?: string }): Promise<string>;
  kill(agentId: string): Promise<void>;
  resume(agentId: string, options?: { mission?: string }): Promise<void>;
  listCompleted(projectId?: string): CompletedQuickAgentInfo[];
  dismissCompleted(projectId: string, agentId: string): void;
  getDetailedStatus(agentId: string): PluginAgentDetailedStatus | null;
  getModelOptions(projectId?: string): Promise<ModelOption[]>;
  onStatusChange(callback: (agentId: string, status: string, prevStatus: string) => void): Disposable;
  /** Subscribe to any change in the agents store (status, detailed status, new/removed agents). */
  onAnyChange(callback: () => void): Disposable;
}

export interface HubAPI {
  // Placeholder for hub integration
  refresh(): void;
}

export interface NavigationAPI {
  focusAgent(agentId: string): void;
  setExplorerTab(tabId: string): void;
  /** Open an agent in a pop-out window. */
  popOutAgent(agentId: string): Promise<void>;
  /** Toggle the sidebar panel visibility. */
  toggleSidebar(): void;
  /** Toggle the accessory panel visibility. */
  toggleAccessoryPanel(): void;
}

export interface WidgetsAPI {
  AgentTerminal: React.ComponentType<{ agentId: string; focused?: boolean }>;
  SleepingAgent: React.ComponentType<{ agentId: string }>;
  AgentAvatar: React.ComponentType<{
    agentId: string;
    size?: 'sm' | 'md';
    showStatusRing?: boolean;
  }>;
  QuickAgentGhost: React.ComponentType<{
    completed: CompletedQuickAgentInfo;
    onDismiss: () => void;
    onDelete?: () => void;
  }>;
}

export interface TerminalAPI {
  /** Spawn an interactive shell in the given directory (defaults to project root). */
  spawn(sessionId: string, cwd?: string): Promise<void>;
  /** Write data to a terminal session. */
  write(sessionId: string, data: string): void;
  /** Resize a terminal session. */
  resize(sessionId: string, cols: number, rows: number): void;
  /** Kill a terminal session. */
  kill(sessionId: string): Promise<void>;
  /** Get buffered output for replay on reconnect. */
  getBuffer(sessionId: string): Promise<string>;
  /** Subscribe to terminal data output. */
  onData(sessionId: string, callback: (data: string) => void): Disposable;
  /** Subscribe to terminal exit events. */
  onExit(sessionId: string, callback: (exitCode: number) => void): Disposable;
  /** React component that renders an xterm.js terminal connected to a session. */
  ShellTerminal: React.ComponentType<{ sessionId: string; focused?: boolean }>;
}

export interface PluginContextInfo {
  mode: PluginRenderMode;
  projectId?: string;
  projectPath?: string;
}

export interface LoggingAPI {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  fatal(msg: string, meta?: Record<string, unknown>): void;
}

export interface FileStatInfo {
  size: number;
  isDirectory: boolean;
  isFile: boolean;
  modifiedAt: number;
}

export interface FilesAPI {
  readTree(relativePath?: string, options?: { includeHidden?: boolean; depth?: number }): Promise<FileNode[]>;
  readFile(relativePath: string): Promise<string>;
  readBinary(relativePath: string): Promise<string>;
  writeFile(relativePath: string, content: string): Promise<void>;
  stat(relativePath: string): Promise<FileStatInfo>;
  rename(oldRelativePath: string, newRelativePath: string): Promise<void>;
  copy(srcRelativePath: string, destRelativePath: string): Promise<void>;
  mkdir(relativePath: string): Promise<void>;
  delete(relativePath: string): Promise<void>;
  showInFolder(relativePath: string): Promise<void>;
  /** Returns a FilesAPI scoped to an external root directory (requires files.external permission). */
  forRoot(rootName: string): FilesAPI;
}

// ── Agent Config API (v0.6+) ──────────────────────────────────────────

/**
 * Options for cross-project agent config operations.
 * When `projectId` is specified, the operation targets that project instead of
 * the current project. Requires the 'agent-config.cross-project' permission,
 * and the target project must also have this plugin enabled (bilateral consent).
 */
export interface AgentConfigTargetOptions {
  projectId?: string;
}

export interface AgentConfigAPI {
  /**
   * Inject a skill definition for project agents.
   * When clubhouse mode is on, integrates with materialization.
   * When off, writes directly to the orchestrator's skills directory.
   * Pass `opts.projectId` to target a different project (requires 'agent-config.cross-project').
   */
  injectSkill(name: string, content: string, opts?: AgentConfigTargetOptions): Promise<void>;
  /** Remove a previously injected skill. */
  removeSkill(name: string, opts?: AgentConfigTargetOptions): Promise<void>;
  /** List skills injected by this plugin. */
  listInjectedSkills(opts?: AgentConfigTargetOptions): Promise<string[]>;
  /**
   * Inject an agent template definition for project agents.
   * When clubhouse mode is on, integrates with materialization.
   * When off, writes directly to the orchestrator's agent templates directory.
   * Pass `opts.projectId` to target a different project (requires 'agent-config.cross-project').
   */
  injectAgentTemplate(name: string, content: string, opts?: AgentConfigTargetOptions): Promise<void>;
  /** Remove a previously injected agent template. */
  removeAgentTemplate(name: string, opts?: AgentConfigTargetOptions): Promise<void>;
  /** List agent templates injected by this plugin. */
  listInjectedAgentTemplates(opts?: AgentConfigTargetOptions): Promise<string[]>;
  /**
   * Append content to the project instruction file.
   * Content is added at the end with a plugin attribution comment.
   * When clubhouse mode is on, integrates with materialization pipeline.
   * When off, appends directly to the instruction file.
   * Pass `opts.projectId` to target a different project (requires 'agent-config.cross-project').
   */
  appendInstructions(content: string, opts?: AgentConfigTargetOptions): Promise<void>;
  /** Remove previously appended instruction content from this plugin. */
  removeInstructionAppend(opts?: AgentConfigTargetOptions): Promise<void>;
  /** Get the content currently appended by this plugin (null if none). */
  getInstructionAppend(opts?: AgentConfigTargetOptions): Promise<string | null>;
  /**
   * Add permission allow rules for project agents.
   * Requires the elevated 'agent-config.permissions' permission.
   * Rules are namespaced per plugin and merged during materialization.
   * Pass `opts.projectId` to target a different project (requires 'agent-config.cross-project').
   */
  addPermissionAllowRules(rules: string[], opts?: AgentConfigTargetOptions): Promise<void>;
  /**
   * Add permission deny rules for project agents.
   * Requires the elevated 'agent-config.permissions' permission.
   * Pass `opts.projectId` to target a different project (requires 'agent-config.cross-project').
   */
  addPermissionDenyRules(rules: string[], opts?: AgentConfigTargetOptions): Promise<void>;
  /** Remove all permission rules injected by this plugin. */
  removePermissionRules(opts?: AgentConfigTargetOptions): Promise<void>;
  /** Get the permission rules currently injected by this plugin. */
  getPermissionRules(opts?: AgentConfigTargetOptions): Promise<{ allow: string[]; deny: string[] }>;
  /**
   * Inject MCP server configuration for project agents.
   * Requires the elevated 'agent-config.mcp' permission.
   * Configuration is merged into the agent's .mcp.json during materialization.
   * Pass `opts.projectId` to target a different project (requires 'agent-config.cross-project').
   */
  injectMcpServers(servers: Record<string, unknown>, opts?: AgentConfigTargetOptions): Promise<void>;
  /** Remove MCP server configurations injected by this plugin. */
  removeMcpServers(opts?: AgentConfigTargetOptions): Promise<void>;
  /** Get the MCP server configurations currently injected by this plugin. */
  getInjectedMcpServers(opts?: AgentConfigTargetOptions): Promise<Record<string, unknown>>;
}

// ── Badges API ────────────────────────────────────────────────────────
export interface BadgesAPI {
  /** Set or update a badge. Key is unique within this plugin + target combo. */
  set(options: {
    key: string;
    type: 'count' | 'dot';
    value?: number;
    target:
      | { tab: string }
      | { appPlugin: true };
  }): void;

  /** Clear a specific badge by key. */
  clear(key: string): void;

  /** Clear all badges set by this plugin. */
  clearAll(): void;
}

// ── Process API ───────────────────────────────────────────────────────
export interface ProcessExecOptions {
  timeout?: number;
}

export interface ProcessExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ProcessAPI {
  exec(command: string, args: string[], options?: ProcessExecOptions): Promise<ProcessExecResult>;
}

// ── Composite PluginAPI ────────────────────────────────────────────────
export interface PluginAPI {
  project: ProjectAPI;
  projects: ProjectsAPI;
  git: GitAPI;
  storage: StorageAPI;
  ui: UIAPI;
  commands: CommandsAPI;
  events: EventsAPI;
  settings: SettingsAPI;
  agents: AgentsAPI;
  hub: HubAPI;
  navigation: NavigationAPI;
  widgets: WidgetsAPI;
  terminal: TerminalAPI;
  logging: LoggingAPI;
  files: FilesAPI;
  process: ProcessAPI;
  badges: BadgesAPI;
  agentConfig: AgentConfigAPI;
  context: PluginContextInfo;
}

// ── Startup marker (safe mode) ─────────────────────────────────────────
export interface StartupMarker {
  timestamp: number;
  attempt: number;
  lastEnabledPlugins: string[];
}

// ── IPC request types ──────────────────────────────────────────────────
export interface PluginStorageReadRequest {
  pluginId: string;
  scope: 'project' | 'project-local' | 'global';
  key: string;
  projectPath?: string;
}

export interface PluginStorageWriteRequest {
  pluginId: string;
  scope: 'project' | 'project-local' | 'global';
  key: string;
  value: unknown;
  projectPath?: string;
}

export interface PluginStorageDeleteRequest {
  pluginId: string;
  scope: 'project' | 'project-local' | 'global';
  key: string;
  projectPath?: string;
}

export interface PluginStorageListRequest {
  pluginId: string;
  scope: 'project' | 'project-local' | 'global';
  projectPath?: string;
}

export interface PluginFileRequest {
  pluginId: string;
  scope: 'project' | 'project-local' | 'global';
  relativePath: string;
  projectPath?: string;
}

export interface PluginStorageEntry {
  key: string;
  value: unknown;
}
