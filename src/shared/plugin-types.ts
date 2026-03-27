import type { FileNode, ThemeColors, HljsColors, TerminalColors, ThemeFonts, ThemeGradients } from './types';

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
  | 'files.watch'
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
  | 'agents.free-agent-mode'
  | 'agent-config.mcp'
  | 'sounds'
  | 'theme'
  | 'workspace'
  | 'workspace.watch'
  | 'workspace.cross-plugin'
  | 'workspace.shared'
  | 'workspace.cross-project'
  | 'canvas'
  | 'annex'
  | 'companion'
  | 'mcp.tools';

export const ALL_PLUGIN_PERMISSIONS: readonly PluginPermission[] = [
  'files',
  'files.external',
  'files.watch',
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
  'agents.free-agent-mode',
  'agent-config.mcp',
  'sounds',
  'theme',
  'workspace',
  'workspace.watch',
  'workspace.cross-plugin',
  'workspace.shared',
  'workspace.cross-project',
  'canvas',
  'annex',
  'companion',
  'mcp.tools',
] as const;

// ── Permission risk levels ────────────────────────────────────────────
export type PermissionRiskLevel = 'safe' | 'elevated' | 'dangerous';

/**
 * Formal parent-child hierarchy for permissions.
 * Each key is a child permission that requires its value (the parent) to also be declared.
 * The manifest validator uses this map to auto-derive parent requirements rather than
 * maintaining hand-written checks for each relationship.
 */
export const PERMISSION_HIERARCHY: Readonly<Partial<Record<PluginPermission, PluginPermission>>> = {
  'files.external': 'files',
  'files.watch': 'files',
  'agent-config.cross-project': 'agent-config',
  'agent-config.permissions': 'agent-config',
  'agent-config.mcp': 'agent-config',
  'agents.free-agent-mode': 'agents',
  'workspace.watch': 'workspace',
  'workspace.cross-plugin': 'workspace',
  'workspace.shared': 'workspace',
  'workspace.cross-project': 'workspace',
};

/**
 * Risk classification for each permission.
 * - safe: read-only or sandboxed operations with minimal blast radius
 * - elevated: write access, cross-boundary operations, or system integration
 * - dangerous: bypasses security boundaries or grants unrestricted control
 */
export const PERMISSION_RISK_LEVELS: Readonly<Record<PluginPermission, PermissionRiskLevel>> = {
  // safe — read-only or sandboxed
  logging: 'safe',
  theme: 'safe',
  events: 'safe',
  badges: 'safe',
  widgets: 'safe',
  commands: 'safe',
  navigation: 'safe',
  notifications: 'safe',
  sounds: 'safe',
  storage: 'safe',
  git: 'safe',

  // elevated — write access or system integration
  files: 'elevated',
  'files.external': 'elevated',
  'files.watch': 'elevated',
  terminal: 'elevated',
  agents: 'elevated',
  projects: 'elevated',
  process: 'elevated',
  'agent-config': 'elevated',
  'agent-config.cross-project': 'elevated',
  'agent-config.mcp': 'elevated',

  // elevated — canvas widget registration
  canvas: 'elevated',

  // safe — annex remote-control opt-in
  annex: 'safe',

  // elevated — workspace access
  workspace: 'elevated',
  'workspace.watch': 'elevated',
  'workspace.cross-plugin': 'elevated',
  'workspace.shared': 'elevated',

  // elevated — companion agent and MCP tool contribution
  companion: 'elevated',
  'mcp.tools': 'elevated',

  // dangerous — bypasses security boundaries
  'agent-config.permissions': 'dangerous',
  'agents.free-agent-mode': 'dangerous',
  'workspace.cross-project': 'dangerous',
};

/** Display labels for risk levels. */
export const RISK_LEVEL_LABELS: Readonly<Record<PermissionRiskLevel, string>> = {
  safe: 'Safe',
  elevated: 'Elevated',
  dangerous: 'Dangerous',
};

/**
 * Return the parent permission required for a given permission, or null if it is a root permission.
 */
export function getParentPermission(permission: PluginPermission): PluginPermission | null {
  return PERMISSION_HIERARCHY[permission] ?? null;
}

/**
 * Return all ancestor permissions required for a given permission (parent, grandparent, etc.).
 */
export function getRequiredParentPermissions(permission: PluginPermission): PluginPermission[] {
  const parents: PluginPermission[] = [];
  let current: PluginPermission | null = getParentPermission(permission);
  while (current !== null) {
    parents.push(current);
    current = getParentPermission(current);
  }
  return parents;
}

export interface PluginExternalRoot {
  settingKey: string;
  root: string;
}

export const PERMISSION_DESCRIPTIONS: Record<PluginPermission, string> = {
  files: 'Read and write files within the project directory',
  'files.external': 'Access files outside the project directory',
  'files.watch': 'Watch files and directories for changes',
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
  'agents.free-agent-mode': 'Spawn agents with all permissions bypassed (elevated, dangerous)',
  'agent-config.mcp': 'Inject MCP server configurations into project agents (elevated)',
  sounds: 'Register and manage custom notification sound packs',
  theme: 'Read the current theme and subscribe to theme changes',
  workspace: 'Read and write files in the plugin workspace directory',
  'workspace.watch': 'Watch workspace files and directories for changes',
  'workspace.cross-plugin': 'Read another plugin\'s workspace (requires target to declare workspace.shared)',
  'workspace.shared': 'Allow other plugins with workspace.cross-plugin to read this plugin\'s workspace',
  'workspace.cross-project': 'Access workspace data scoped to other projects where the plugin is enabled',
  canvas: 'Register custom canvas widget types and query canvas widgets',
  annex: 'Declares this plugin as compatible with Annex remote control',
  companion: 'Own a singleton companion agent with a persistent workspace (v0.9+)',
  'mcp.tools': 'Contribute custom tools to the Clubhouse MCP server (v0.9+)',
};

export interface PluginHelpTopic {
  id: string;
  title: string;
  content: string; // markdown
}

export interface PluginHelpContribution {
  topics?: PluginHelpTopic[];
}

export interface PluginSoundPackDeclaration {
  /** Display name for the sound pack. */
  name: string;
  /**
   * Mapping of sound event names to audio file paths relative to the plugin directory.
   * e.g., { "agent-done": "sounds/done.mp3", "error": "sounds/error.wav" }
   */
  sounds: Record<string, string>;
}

/** Declare a color theme that ships with this plugin (v0.7+). */
export interface PluginThemeDeclaration {
  /** Unique theme ID (will be prefixed with `plugin:{pluginId}:` on registration). */
  id: string;
  /** Display name for the theme. */
  name: string;
  /** Whether this is a dark or light theme. */
  type: 'dark' | 'light';
  /** Core UI colors. */
  colors: ThemeColors;
  /** Syntax highlighting colors. */
  hljs: HljsColors;
  /** Terminal colors. */
  terminal: TerminalColors;
  /** Custom font families (experimental — requires themeGradients feature flag). */
  fonts?: ThemeFonts;
  /** CSS gradients (experimental — requires themeGradients feature flag). */
  gradients?: ThemeGradients;
}

/** Declare agent configuration that is auto-injected on plugin registration (v0.7+). */
export interface PluginAgentConfigDeclaration {
  /** Skills to inject — mapping of skill name to markdown content. */
  skills?: Record<string, string>;
  /** MCP server configurations to inject. */
  mcpServers?: Record<string, unknown>;
  /** Agent templates to inject — mapping of template name to markdown content. */
  agentTemplates?: Record<string, string>;
}

/** Declare a global dialog action (v0.7+). */
export interface PluginGlobalDialogDeclaration {
  /** Display label for the dialog in command palette / menus. */
  label: string;
  /** SVG icon string or icon name. */
  icon?: string;
  /** Default keyboard binding (e.g. "Meta+Shift+B"). */
  defaultBinding?: string;
  /** Command ID to register for opening this dialog (auto-generated if not specified). */
  commandId?: string;
}

/** Declare a canvas widget type that ships with this plugin (v0.7+, requires 'canvas' permission). */
export interface PluginCanvasWidgetDeclaration {
  /** Unique widget type ID within the plugin (will be qualified as `plugin:{pluginId}:{id}` at runtime). */
  id: string;
  /** Display label shown in the "Add…" context menu. */
  label: string;
  /** SVG icon string or icon name shown in context menu and title bar. */
  icon?: string;
  /** Default widget size in pixels. Falls back to 480×480 if omitted. */
  defaultSize?: { width: number; height: number };
  /** Keys this widget type exposes as queryable metadata (e.g. ['url', 'sessionId']). */
  metadataKeys?: string[];
  /** When true, the widget can be pinned to the canvas controls bar (v0.9+). */
  pinnableToControls?: boolean;
}

export interface PluginContributes {
  tab?: {
    label: string;
    icon?: string;        // SVG string or icon name
    layout?: 'sidebar-content' | 'full';  // default: 'sidebar-content'
    /** Custom window/tab title (v0.8+). Defaults to label if not specified. */
    title?: string;
  };
  railItem?: {
    label: string;
    icon?: string;
    position?: 'top' | 'bottom';  // default: 'top'
    /** Custom window/tab title (v0.8+). Defaults to label if not specified. */
    title?: string;
  };
  commands?: PluginCommandDeclaration[];
  settings?: PluginSettingDeclaration[];
  storage?: PluginStorageDeclaration;
  help?: PluginHelpContribution;
  /** Declare a sound pack that ships with this plugin. */
  sounds?: PluginSoundPackDeclaration;
  /** Declare color themes that ship with this plugin (v0.7+). */
  themes?: PluginThemeDeclaration[];
  /** Declare agent configuration to auto-inject (v0.7+). */
  agentConfig?: PluginAgentConfigDeclaration;
  /** Declare a global dialog action (v0.7+). */
  globalDialog?: PluginGlobalDialogDeclaration;
  /** Declare canvas widget types that this plugin provides (v0.7+, requires 'canvas' permission). */
  canvasWidgets?: PluginCanvasWidgetDeclaration[];
}

/** Plugin kind: 'plugin' (default) has a main module; 'pack' is headless (no JS, manifest-only); 'workspace' owns a companion agent and workspace (v0.9+). */
export type PluginKind = 'plugin' | 'pack' | 'workspace';

/** Companion agent configuration for workspace plugins (v0.9+). */
export interface PluginCompanionConfig {
  /** Whether this plugin owns a companion agent. */
  enabled: boolean;
  /** Default model for the companion agent. */
  defaultModel?: string;
  /** System prompt for the companion agent. */
  systemPrompt?: string;
}

/** MCP tool definition contributed by a plugin (v0.9+). */
export interface PluginMcpToolDefinition {
  /** Tool name suffix (will be prefixed with plugin namespace). */
  name: string;
  /** Human-readable description shown to agents. */
  description: string;
  /** JSON Schema for tool arguments. */
  inputSchema: Record<string, unknown>;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  engine: { api: number };
  /** Plugin kind: 'plugin' (default), 'pack' (headless), or 'workspace' (companion agent, v0.9+). */
  kind?: PluginKind;
  scope: 'project' | 'app' | 'dual';
  main?: string;                     // path to main module relative to plugin dir
  contributes?: PluginContributes;
  settingsPanel?: 'declarative' | 'custom';
  permissions?: PluginPermission[];         // required for v0.5+ plugins (optional for packs)
  externalRoots?: PluginExternalRoot[];     // requires 'files.external' permission
  allowedCommands?: string[];              // requires 'process' permission
  /** Companion agent configuration (v0.9+, requires 'companion' permission). */
  companion?: PluginCompanionConfig;
  /** When true, this plugin requires MCP to be enabled and will be hidden from settings and canvas when MCP is off. */
  requiresMcp?: boolean;
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
  | 'incompatible'
  | 'pending-approval';

export type PluginSource = 'builtin' | 'community' | 'marketplace';

export interface PluginRegistryEntry {
  manifest: PluginManifest;
  status: PluginStatus;
  error?: string;
  source: PluginSource;
  pluginPath: string;
  /** New permissions added by an update that require user approval before re-activation. */
  pendingPermissions?: PluginPermission[];
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
  /** Global dialog panel rendered as a modal overlay (v0.7+). */
  DialogPanel?: React.ComponentType<{ api: PluginAPI; onClose: () => void }>;
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

export interface PluginOrchestratorInfo {
  id: string;
  displayName: string;
  shortName: string;
  badge?: string;
  capabilities: {
    headless: boolean;
    hooks: boolean;
    sessionResume: boolean;
    permissions: boolean;
  };
}

export interface AgentInfo {
  id: string;
  name: string;
  kind: 'durable' | 'quick' | 'companion';
  status: 'running' | 'sleeping' | 'waking' | 'creating' | 'error';
  color: string;
  icon?: string;
  exitCode?: number;
  mission?: string;
  projectId: string;
  branch?: string;
  worktreePath?: string;
  model?: string;
  parentAgentId?: string;
  orchestrator?: string;
  freeAgentMode?: boolean;
  /** Plugin-supplied metadata attached at spawn time. @since 0.8 */
  pluginMetadata?: Record<string, string>;
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
  /** Plugin-supplied metadata carried from the spawning agent. @since 0.8 */
  pluginMetadata?: Record<string, string>;
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
  currentBranch(subPath?: string): Promise<string>;
  diff(filePath: string, staged?: boolean): Promise<string>;
}

/** A single action button in an approval dialog. */
export interface ApprovalDialogAction {
  /** Value returned when this action is selected. */
  value: string;
  /** Button label shown in the dialog. */
  label: string;
  /** Visual style: 'primary' (accent), 'danger' (red), or 'default' (subtle). */
  style?: 'primary' | 'danger' | 'default';
}

/** Options for showApprovalDialog. */
export interface ApprovalDialogOptions {
  /** Dialog title (short, e.g. "Approve stage transition"). */
  title: string;
  /** Summary or context body (supports plain text). */
  summary: string;
  /** Action buttons. At least one required. First 'primary' or first action gets Enter key. */
  actions: ApprovalDialogAction[];
}

export interface UIAPI {
  showNotice(message: string): void;
  showError(message: string): void;
  showConfirm(message: string): Promise<boolean>;
  showInput(prompt: string, defaultValue?: string): Promise<string | null>;
  /**
   * Show a rich approval dialog with a title, summary, and multiple action buttons.
   * Returns the `value` of the selected action, or `null` if dismissed (overlay click / Escape).
   * @since 0.8
   */
  showApprovalDialog(options: ApprovalDialogOptions): Promise<string | null>;
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
  set(key: string, value: unknown): void;
  onChange(callback: (key: string, value: unknown) => void): Disposable;
}

export interface ModelOption {
  id: string;
  label: string;
}

export interface AgentsAPI {
  list(): AgentInfo[];
  /** Create a new durable agent in a project and spawn it. Returns the new agent ID. */
  createDurable(options: {
    projectId?: string;
    name: string;
    color: string;
    model?: string;
    useWorktree?: boolean;
    orchestrator?: string;
    freeAgentMode?: boolean;
    mcpIds?: string[];
  }): Promise<string>;
  runQuick(mission: string, options?: { model?: string; systemPrompt?: string; projectId?: string; orchestrator?: string; freeAgentMode?: boolean; metadata?: Record<string, string> }): Promise<string>;
  kill(agentId: string): Promise<void>;
  resume(agentId: string, options?: { mission?: string }): Promise<void>;
  listCompleted(projectId?: string): CompletedQuickAgentInfo[];
  dismissCompleted(projectId: string, agentId: string): void;
  getDetailedStatus(agentId: string): PluginAgentDetailedStatus | null;
  getModelOptions(projectId?: string, orchestrator?: string): Promise<ModelOption[]>;
  listOrchestrators(): PluginOrchestratorInfo[];
  checkOrchestratorAvailability(orchestratorId: string): Promise<{ available: boolean; error?: string }>;
  onStatusChange(callback: (agentId: string, status: string, prevStatus: string) => void): Disposable;
  /** Subscribe to any change in the agents store (status, detailed status, new/removed agents). */
  onAnyChange(callback: () => void): Disposable;
  /** List historical sessions for an agent. */
  listSessions(agentId: string): Promise<Array<{ sessionId: string; startedAt: string; lastActiveAt: string; friendlyName?: string }>>;
  /** Read paginated session transcript events. */
  readSessionTranscript(agentId: string, sessionId: string, offset: number, limit: number): Promise<import('./session-types').SessionTranscriptPage | null>;
  /** Get aggregated session summary (stats, files, tokens). */
  getSessionSummary(agentId: string, sessionId: string): Promise<import('./session-types').SessionSummary | null>;
  /** Spawn or wake the plugin's companion agent. Returns the agent ID. Requires 'companion' permission. @since 0.9 */
  spawnCompanion(options?: { model?: string; systemPrompt?: string }): Promise<string>;
  /** Get the companion agent's current status. Requires 'companion' permission. @since 0.9 */
  getCompanionStatus(): Promise<'sleeping' | 'waking' | 'active' | 'none'>;
  /** Get the companion agent's workspace path. Requires 'companion' permission. @since 0.9 */
  getCompanionWorkspace(): Promise<string>;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface HubAPI {
  // Reserved for future hub integration methods
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
  AgentTerminal: React.ComponentType<{ agentId: string; focused?: boolean; zoneThemeId?: string }>;
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

// ── Canvas widget metadata ───────────────────────────────────────────
/** Flat key-value bag stored on each canvas widget instance for query/filtering. */
export type CanvasWidgetMetadata = Record<string, string | number | boolean | null>;

/** A handle returned by queryWidgets — lightweight reference to a canvas widget instance. */
export interface CanvasWidgetHandle {
  /** Internal unique widget instance ID (e.g. "cv_3"). */
  id: string;
  /** Fully-qualified widget type (e.g. "agent", "plugin:my-plugin:chart"). */
  type: string;
  /** User-facing display name (auto-deduplicated). */
  displayName: string;
  /** Queryable metadata bag. */
  metadata: CanvasWidgetMetadata;
}

/** Filter passed to queryWidgets(). All fields are optional; results match ALL specified criteria. */
export interface CanvasWidgetFilter {
  /** Match exact widget type (e.g. "agent", "plugin:my-plugin:chart"). */
  type?: string;
  /** Match widgets whose metadata contains all of these key-value pairs. */
  metadata?: CanvasWidgetMetadata;
  /** Match widget by internal ID. */
  id?: string;
  /** Substring match on display name (case-insensitive). */
  displayName?: string;
}

/** Props passed to a pinned widget component in the canvas controls bar (v0.9+). */
export interface PinnedWidgetComponentProps {
  /** The widget instance's internal ID. */
  widgetId: string;
  /** The PluginAPI for this plugin. */
  api: PluginAPI;
  /** Current metadata for this widget instance. */
  metadata: CanvasWidgetMetadata;
  /** Callback to update metadata (merges with existing). */
  onUpdateMetadata: (updates: CanvasWidgetMetadata) => void;
}

/** Descriptor provided at runtime when a plugin registers a canvas widget type. */
export interface CanvasWidgetDescriptor {
  /** Widget type ID — must match a declared canvasWidgets[].id in the plugin manifest. */
  id: string;
  /** React component rendered inside the canvas widget frame. Receives the PluginAPI + widget state. */
  component: React.ComponentType<CanvasWidgetComponentProps>;
  /** Optional callback to generate a display name from widget metadata. Defaults to the manifest label. */
  generateDisplayName?: (metadata: CanvasWidgetMetadata) => string;
  /** Compact component rendered in the canvas controls bar when pinned (v0.9+). Required if pinnableToControls is true in the manifest. */
  pinnedComponent?: React.ComponentType<PinnedWidgetComponentProps>;
}

/** Props passed to a plugin-provided canvas widget component. */
export interface CanvasWidgetComponentProps {
  /** The widget instance's internal ID. */
  widgetId: string;
  /** The PluginAPI for this plugin. */
  api: PluginAPI;
  /** Current metadata for this widget instance. */
  metadata: CanvasWidgetMetadata;
  /** Callback to update metadata (merges with existing). */
  onUpdateMetadata: (updates: CanvasWidgetMetadata) => void;
  /** Current widget size in pixels. */
  size: { width: number; height: number };
}

// ── Window API (v0.8+) ────────────────────────────────────────────────
export interface WindowAPI {
  /** Set a custom title for the plugin's tab/window. Overrides the manifest default. */
  setTitle(title: string): void;
  /** Reset the title back to the manifest default (contributes.tab.title or contributes.tab.label). */
  resetTitle(): void;
  /** Get the current effective title. */
  getTitle(): string;
}

export interface CanvasAPI {
  /**
   * Register a canvas widget type at runtime. The widget type `id` must match
   * a declared `contributes.canvasWidgets[].id` in the plugin manifest.
   * Returns a Disposable that unregisters the widget type.
   */
  registerWidgetType(descriptor: CanvasWidgetDescriptor): Disposable;
  /**
   * Query all canvas widget instances matching the filter.
   * Returns lightweight handles (not React components).
   */
  queryWidgets(filter?: CanvasWidgetFilter): CanvasWidgetHandle[];
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
  /** Absolute path to this plugin's stable, per-plugin data directory. Auto-created before activate(). */
  readonly dataDir: string;
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
  /**
   * Watch files matching a glob pattern for changes (v0.7+, requires files.watch permission).
   * Callback receives batched file events. Returns a Disposable to stop watching.
   */
  watch(glob: string, callback: (events: FileEvent[]) => void): Disposable;
  /**
   * Search for text across all files in the project directory.
   */
  search(query: string, options?: {
    caseSensitive?: boolean;
    wholeWord?: boolean;
    regex?: boolean;
    includeGlobs?: string[];
    excludeGlobs?: string[];
    maxResults?: number;
    contextLines?: number;
  }): Promise<import('./types').FileSearchResult>;
}

// ── Workspace API (v0.7+) ─────────────────────────────────────────────

export interface WorkspaceAPI {
  readonly root: string;
  readFile(relativePath: string): Promise<string>;
  writeFile(relativePath: string, content: string): Promise<void>;
  mkdir(relativePath: string): Promise<void>;
  delete(relativePath: string): Promise<void>;
  stat(relativePath: string): Promise<FileStatInfo>;
  exists(relativePath: string): Promise<boolean>;
  listDir(relativePath?: string): Promise<DirectoryEntry[]>;
  readTree(relativePath?: string, opts?: { depth?: number }): Promise<FileNode[]>;
  watch(glob: string, cb: (events: FileEvent[]) => void): Disposable;
  forPlugin(pluginId: string): WorkspaceReadonlyAPI;
  forProject(projectId: string): WorkspaceProjectAPI;
}

export interface WorkspaceReadonlyAPI {
  readonly root: string;
  readFile(relativePath: string): Promise<string>;
  stat(relativePath: string): Promise<FileStatInfo>;
  exists(relativePath: string): Promise<boolean>;
  listDir(relativePath?: string): Promise<DirectoryEntry[]>;
  watch(glob: string, cb: (events: FileEvent[]) => void): Disposable;
}

export interface WorkspaceProjectAPI {
  readonly projectPath: string;
  readonly projectId: string;
  readFile(relativePath: string): Promise<string>;
  writeFile(relativePath: string, content: string): Promise<void>;
  exists(relativePath: string): Promise<boolean>;
  listDir(relativePath?: string): Promise<DirectoryEntry[]>;
  watch(glob: string, cb: (events: FileEvent[]) => void): Disposable;
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
  /**
   * Register a launch wrapper preset for the current project.
   * Writes the wrapper config and MCP catalog to project settings.
   * The preset becomes active immediately.
   */
  contributeWrapperPreset(preset: {
    binary: string;
    separator: string;
    orchestratorMap: Record<string, { subcommand: string }>;
    env?: Record<string, string>;
    mcpCatalog: Array<{ id: string; name: string; description: string }>;
    defaultMcps?: string[];
  }): Promise<void>;
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

// ── Sounds API ────────────────────────────────────────────────────────
export interface SoundsAPI {
  /** Register a sound pack from this plugin. Uses the plugin's sounds/ directory. */
  registerPack(name?: string): Promise<void>;
  /** Unregister the sound pack from this plugin. */
  unregisterPack(): Promise<void>;
  /** List all available sound packs (user + plugin). */
  listPacks(): Promise<Array<{ id: string; name: string; source: 'user' | 'plugin' }>>;
}

// ── Theme API ─────────────────────────────────────────────────────────
export interface ThemeInfo {
  id: string;
  name: string;
  type: 'dark' | 'light';
  colors: Record<string, string>;
  hljs: Record<string, string>;
  terminal: Record<string, string>;
  /** Custom font families (only present when themeGradients experimental flag is on). */
  fonts?: { ui?: string; mono?: string };
  /** CSS gradients (only present when themeGradients experimental flag is on). */
  gradients?: { background?: string; surface?: string; accent?: string };
}

export interface ThemeAPI {
  /** Get the current theme ID and full color definition. */
  getCurrent(): ThemeInfo;
  /** Subscribe to theme changes (fires on user theme switch). Returns a Disposable. */
  onDidChange(callback: (theme: ThemeInfo) => void): Disposable;
  /** Get a single resolved CSS color value by token name (e.g. 'base', 'accent', 'hljs.keyword'). */
  getColor(token: string): string | null;
}

// ── MCP Tool Contribution API (v0.9+) ─────────────────────────────────

/** Result returned by a plugin MCP tool handler. */
export interface PluginMcpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface McpAPI {
  /**
   * Register tools that other agents can call via the Clubhouse MCP.
   * Tools are namespaced per plugin: `plugin__<pluginId>__<toolName>`.
   * Requires 'mcp.tools' permission. @since 0.9
   */
  contributeTools(tools: PluginMcpToolDefinition[]): Promise<void>;
  /** Remove all tools contributed by this plugin. @since 0.9 */
  removeTools(): Promise<void>;
  /** List tools currently contributed by this plugin. @since 0.9 */
  listContributedTools(): Promise<string[]>;
  /**
   * Register a handler for incoming tool calls.
   * The handler receives the tool name (without namespace prefix) and arguments,
   * and must return a result. @since 0.9
   */
  onToolCall(handler: (toolName: string, args: Record<string, unknown>) => Promise<PluginMcpToolResult>): Disposable;
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
  sounds: SoundsAPI;
  theme: ThemeAPI;
  workspace: WorkspaceAPI;
  canvas: CanvasAPI;
  /** Window title management (v0.8+). */
  window: WindowAPI;
  /** MCP tool contribution (v0.9+, requires 'mcp.tools' permission). */
  mcp: McpAPI;
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
