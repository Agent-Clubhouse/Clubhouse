export interface ArchInfo {
  arch: string;
  platform: string;
  rosetta: boolean;
}

export type OrchestratorId = 'claude-code' | (string & {});

export type AgentExecutionMode = 'pty' | 'headless' | 'structured';

export type SpawnMode = 'headless' | 'interactive' | 'structured';

/** Controls what CLI flag is used when agents need autonomous permissions. */
export type FreeAgentPermissionMode = 'auto' | 'skip-all';

export interface ProviderCapabilities {
  headless: boolean;
  structuredOutput: boolean;
  hooks: boolean;
  sessionResume: boolean;
  permissions: boolean;
  structuredMode: boolean;
  structuredProtocol?: 'acp';
}

export interface OrchestratorInfo {
  id: string;
  displayName: string;
  shortName: string;
  badge?: string;
  capabilities: ProviderCapabilities;
  conventions?: {
    configDir: string;
    localInstructionsFile: string;
    legacyInstructionsFile: string;
    mcpConfigFile: string;
    skillsDir: string;
    agentTemplatesDir: string;
    localSettingsFile: string;
  };
}

export interface Project {
  id: string;
  name: string;
  path: string;
  color?: string;       // AGENT_COLORS id (e.g. 'emerald')
  icon?: string;        // filename in ~/.clubhouse/project-icons/
  emoji?: string;       // single emoji character used as icon (mutually exclusive with icon)
  displayName?: string; // user-set display name (overrides `name` in UI)
  orchestrator?: OrchestratorId;
}

export type AgentStatus = 'running' | 'sleeping' | 'waking' | 'creating' | 'error';
export type AgentKind = 'durable' | 'quick' | 'companion';

export interface Agent {
  id: string;
  projectId: string;
  name: string;
  kind: AgentKind;
  status: AgentStatus;
  color: string;
  icon?: string;         // filename in ~/.clubhouse/agent-icons/
  emoji?: string;        // single emoji character used as icon (mutually exclusive with icon)
  worktreePath?: string;
  branch?: string;
  exitCode?: number;
  errorMessage?: string;
  mission?: string;
  model?: string;
  parentAgentId?: string;
  orchestrator?: OrchestratorId;
  headless?: boolean;
  /** Execution mode: 'pty' (terminal), 'headless' (feed), or 'structured' (rich UI) */
  executionMode?: AgentExecutionMode;
  freeAgentMode?: boolean;
  /** When true, this agent runs in structured mode instead of PTY */
  structuredMode?: boolean;
  /** MCP IDs active for this agent via launch wrapper */
  mcpIds?: string[];
  /** Set when the agent is resuming a previous CLI session (spinner overlay) */
  resuming?: boolean;
  /** Plugin-supplied metadata for correlating agents to domain objects (e.g. boardId, cardId). */
  pluginMetadata?: Record<string, string>;
  /** Plugin ID that owns this companion agent (v0.9+). */
  pluginOwner?: string;
  /** Path to companion workspace directory (v0.9+). */
  companionWorkspace?: string;
}

export interface CompletedQuickAgent {
  id: string;
  projectId: string;
  name: string;
  mission: string;
  summary: string | null;
  filesModified: string[];
  exitCode: number;
  completedAt: number;
  parentAgentId?: string;
  headless?: boolean;
  transcriptPath?: string;
  costUsd?: number;
  durationMs?: number;
  toolsUsed?: string[];
  orchestrator?: string;
  model?: string;
  cancelled?: boolean;
  /** Plugin-supplied metadata carried from the spawning agent. */
  pluginMetadata?: Record<string, string>;
}

// --- Profile types ---

/** Per-orchestrator env config within a profile */
export interface OrchestratorProfileEntry {
  env: Record<string, string>;  // e.g. { CLAUDE_CONFIG_DIR: "~/.claude-work" }
}

/** Named profile containing env configs for multiple orchestrators */
export interface OrchestratorProfile {
  id: string;
  name: string;           // e.g. "Work", "Personal"
  orchestrators: Record<string, OrchestratorProfileEntry>;
}

export interface ProfilesSettings {
  profiles: OrchestratorProfile[];
}

// --- Config inheritance types ---

export interface PermissionsConfig {
  allow?: string[];
  deny?: string[];
}

export interface McpConfig {
  mcpServers: Record<string, McpServerDef>;
}

export interface McpServerDef {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: string;
  url?: string;
}

export interface QuickAgentDefaults {
  systemPrompt?: string;
  allowedTools?: string[];
  defaultModel?: string;
  freeAgentMode?: boolean;
}

export type SourceControlProvider = 'github' | 'azure-devops';

/** Project-level default settings applied as snapshots when creating new agents. */
export interface ProjectAgentDefaults {
  instructions?: string;
  permissions?: PermissionsConfig;
  mcpJson?: string;
  freeAgentMode?: boolean;
  sourceControlProvider?: SourceControlProvider;
  buildCommand?: string;
  testCommand?: string;
  lintCommand?: string;
  /** Default profile to use for agents in this project */
  profileId?: string;
  /** Shell command prefix prepended before the CLI binary (e.g. ". ./init.ps1 &&") */
  commandPrefix?: string;
}

/** A recorded CLI session for a durable agent */
export interface SessionInfo {
  /** CLI session ID (provider-specific format, e.g. UUID for Claude Code) */
  sessionId: string;
  /** When this session was first started */
  startedAt: string;
  /** When this session was last active */
  lastActiveAt: string;
  /** User-assigned friendly name for easy identification */
  friendlyName?: string;
}

export interface DurableAgentConfig {
  id: string;
  name: string;
  color: string;
  icon?: string;        // filename in ~/.clubhouse/agent-icons/
  emoji?: string;       // single emoji character used as icon
  branch?: string;
  worktreePath?: string;
  createdAt: string;
  model?: string;
  quickAgentDefaults?: QuickAgentDefaults;
  orchestrator?: OrchestratorId;
  freeAgentMode?: boolean;
  /** When true, this durable agent spawns in structured mode instead of PTY */
  structuredMode?: boolean;
  clubhouseModeOverride?: boolean;
  /** Last CLI session ID, used to resume previous session on wake */
  lastSessionId?: string;
  /** History of CLI sessions for this agent */
  sessionHistory?: SessionInfo[];
  /** MCP IDs to inject via launch wrapper (when unset, falls back to project defaultMcps) */
  mcpIds?: string[];
  /** Per-agent override for the Clubhouse MCP bridge feature. */
  mcpOverride?: boolean;
  /** Persona template ID applied at creation. Used to re-inject instructions on materialization. */
  persona?: string;
}

/** Maps an orchestrator ID to its wrapper subcommand */
export interface WrapperOrchestratorMapping {
  subcommand: string;
}

/** Configuration for a CLI launch wrapper. */
export interface LaunchWrapperConfig {
  /** Path or name of the wrapper binary */
  binary: string;
  /** Separator token between wrapper args and original CLI args (e.g. "--") */
  separator: string;
  /** Per-orchestrator subcommand mapping */
  orchestratorMap: Record<string, WrapperOrchestratorMapping>;
  /** Optional environment variables to set when launching through the wrapper */
  env?: Record<string, string>;
}

/** An MCP server available through a launch wrapper */
export interface McpCatalogEntry {
  /** Short identifier used in --mcp flags (e.g. "ado", "kusto") */
  id: string;
  /** Human-readable display name */
  name: string;
  /** Brief description of the MCP's functionality */
  description: string;
}

export interface ClubhouseModeSettings {
  enabled: boolean;
  projectOverrides?: Record<string, boolean>;
  sourceControlProvider?: SourceControlProvider;
}

export type ConfigDiffCategory = 'instructions' | 'permissions-allow' | 'permissions-deny' | 'mcp' | 'skills' | 'agent-templates';
export type ConfigDiffAction = 'added' | 'removed' | 'modified';

export interface ConfigDiffItem {
  id: string;                    // e.g. "permissions-allow:Read(.clubhouse/agents/x/**)"
  category: ConfigDiffCategory;
  action: ConfigDiffAction;
  label: string;                 // Human-readable
  agentValue?: string;           // Current agent value (resolved)
  defaultValue?: string;         // Project default value (resolved)
  rawAgentValue?: string;        // Agent value with wildcards re-applied (for propagation)
}

export interface ConfigDiffResult {
  agentId: string;
  agentName: string;
  hasDiffs: boolean;
  items: ConfigDiffItem[];
}

export interface MaterializationPreview {
  instructions: string;
  permissions: PermissionsConfig;
  mcpJson: string | null;
  skills: string[];
  agentTemplates: string[];
}

/** Provenance of a config item — who added it */
export type ConfigProvenance =
  | { source: 'user' }
  | { source: 'built-in' }
  | { source: 'plugin'; pluginId: string };

/** A config item with provenance for the management UI */
export interface ProvenancedConfigItem {
  /** Unique key for this item */
  id: string;
  /** Human label */
  label: string;
  /** The raw value */
  value: string;
  /** Who added it */
  provenance: ConfigProvenance;
}

/** Structured breakdown of all project agent default configs with provenance */
export interface ProjectConfigBreakdown {
  /** User-authored instruction text (without plugin blocks) */
  userInstructions: string;
  /** Plugin instruction blocks with attribution */
  pluginInstructionBlocks: ProvenancedConfigItem[];
  /** Permission allow rules with attribution */
  allowRules: ProvenancedConfigItem[];
  /** Permission deny rules with attribution */
  denyRules: ProvenancedConfigItem[];
  /** Skills with attribution */
  skills: ProvenancedConfigItem[];
  /** Agent templates with attribution */
  agentTemplates: ProvenancedConfigItem[];
  /** MCP servers with attribution */
  mcpServers: ProvenancedConfigItem[];
  /** IDs of plugins that have orphaned injections (plugin no longer installed) */
  orphanedPluginIds: string[];
}

export interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
  /** In ADO mode, path to the sibling .md index page for this folder */
  indexPath?: string;
}

export type ExplorerTab = string;

// ── File search types ─────────────────────────────────────────────────

export interface FileSearchOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  includeGlobs?: string[];
  excludeGlobs?: string[];
  maxResults?: number;
  contextLines?: number;
}

export interface FileSearchMatch {
  line: number;
  column: number;
  length: number;
  lineContent: string;
  contextBefore?: string[];
  contextAfter?: string[];
}

export interface FileSearchFileResult {
  filePath: string;
  matches: FileSearchMatch[];
}

export interface FileSearchResult {
  results: FileSearchFileResult[];
  totalMatches: number;
  truncated: boolean;
}


export interface ClipboardSettings {
  clipboardCompat: boolean;
}

export interface BadgeSettings {
  enabled: boolean;
  pluginBadges: boolean;
  projectRailBadges: boolean;
  projectOverrides?: Record<string, Partial<Pick<BadgeSettings, 'enabled' | 'pluginBadges' | 'projectRailBadges'>>>;
}

export interface NotificationSettings {
  enabled: boolean;
  permissionNeeded: boolean;
  agentIdle: boolean;
  agentStopped: boolean;
  agentError: boolean;
  playSound: boolean;
}

// ── Sound pack types ──────────────────────────────────────────────────

export type SoundEvent =
  | 'agent-done'
  | 'error'
  | 'permission'
  | 'permission-granted'
  | 'permission-denied'
  | 'agent-wake'
  | 'agent-sleep'
  | 'agent-focus'
  | 'notification';

export const ALL_SOUND_EVENTS: readonly SoundEvent[] = [
  'agent-done',
  'error',
  'permission',
  'permission-granted',
  'permission-denied',
  'agent-wake',
  'agent-sleep',
  'agent-focus',
  'notification',
] as const;

export const SOUND_EVENT_LABELS: Record<SoundEvent, string> = {
  'agent-done': 'Agent Finished',
  'error': 'Error',
  'permission': 'Permission Request',
  'permission-granted': 'Permission Granted',
  'permission-denied': 'Permission Denied',
  'agent-wake': 'Agent Wake',
  'agent-sleep': 'Agent Sleep',
  'agent-focus': 'Agent Focus',
  'notification': 'General Notification',
};

export const SUPPORTED_SOUND_EXTENSIONS = ['.mp3', '.wav', '.ogg'] as const;

export interface SoundPackInfo {
  id: string;           // directory name
  name: string;         // display name from manifest or directory name
  description?: string;
  author?: string;
  sounds: Partial<Record<SoundEvent, string>>; // event → filename
  source: 'user' | 'plugin';
  pluginId?: string;    // set when source === 'plugin'
}

export interface SoundEventSettings {
  enabled: boolean;
  volume: number; // 0-100
}

/** Per-slot pack assignment: which pack provides the sound for a given event */
export interface SlotAssignment {
  packId: string; // which pack provides the sound for this slot
}

export interface SoundSettings {
  /** @deprecated Use slotAssignments instead. Kept for migration. */
  activePack?: string | null;
  /** Per-slot pack assignments. Missing key = no custom sound (OS default). */
  slotAssignments: Partial<Record<SoundEvent, SlotAssignment>>;
  eventSettings: Record<SoundEvent, SoundEventSettings>;
  projectOverrides?: Record<string, {
    /** @deprecated Use slotAssignments instead. */
    activePack?: string | null;
    slotAssignments?: Partial<Record<SoundEvent, SlotAssignment>>;
  }>;
}

export type SettingsSubPage = 'project' | 'notifications' | 'logging' | 'display' | 'editor' | 'orchestrators' | 'profiles' | 'plugins' | 'plugin-detail' | 'about' | 'updates' | 'whats-new' | 'keyboard-shortcuts' | 'annex' | 'annex-control' | 'experimental' | 'mcp';

// --- MCP settings ---

export interface McpSettings {
  enabled: boolean;
  projectDefault?: boolean;
  projectOverrides?: Record<string, boolean>;
}

// --- Editor settings ---

export interface EditorSettings {
  /** The command used to open files in the external editor (e.g. 'code', 'cursor', 'zed') */
  editorCommand: string;
  /** Display name for the editor (e.g. 'VS Code', 'Cursor', 'Zed') */
  editorName: string;
}

// --- Experimental settings ---

export interface ExperimentalSettings {
  /** Record of feature flags: key is the feature id, value is enabled/disabled */
  [key: string]: boolean;
}

// --- Security settings ---

export interface SecuritySettings {
  /** Allow loading file:// URLs in webview widgets and the browser view. Default: false. */
  allowLocalFileWebviews: boolean;
}

// --- Annex (LAN monitoring) types ---

export interface AnnexSettings {
  /** @deprecated Use enableServer/enableClient instead. Kept for backward compat migration. */
  enabled?: boolean;
  /** Allow remote control of this machine (run annex server + mDNS advertisement) */
  enableServer: boolean;
  /** Connect to and control satellites (run annex client + Bonjour discovery) */
  enableClient: boolean;
  deviceName: string;
  /** Display alias for this instance (defaults to os.hostname()) */
  alias: string;
  /** Icon identifier for this instance (defaults to 'computer') */
  icon: string;
  /** Color identifier from AGENT_COLORS palette (defaults to 'indigo') */
  color: string;
  /** Whether to auto-reconnect to satellites after disconnection */
  autoReconnect: boolean;
}

export interface AnnexStatus {
  advertising: boolean;
  port: number;
  pin: string;
  connectedCount: number;
  /** SHA-256 fingerprint of this instance's public key (colon-separated hex) */
  fingerprint: string;
  /** Display alias for this instance */
  alias: string;
  /** Icon identifier */
  icon: string;
  /** Color identifier */
  color: string;
}

// ── Annex peer types ──────────────────────────────────────────────────

/** Role of a peer relative to this machine. */
export type AnnexPeerRole = 'controller' | 'satellite';

export interface AnnexPeer {
  /** SHA-256 fingerprint of the peer's public key */
  fingerprint: string;
  /** Base64-encoded Ed25519 public key (DER/SPKI) */
  publicKey: string;
  /** Display alias */
  alias: string;
  /** Icon identifier */
  icon: string;
  /** Color identifier */
  color: string;
  /** ISO timestamp of when the pairing was established */
  pairedAt: string;
  /** ISO timestamp of last successful connection */
  lastSeen: string;
  /**
   * The role of this peer relative to us:
   * - 'controller': This peer controls us (we are their satellite)
   * - 'satellite': This peer is our satellite (we control them)
   * Legacy peers without a role are treated as 'satellite' for backward compat.
   */
  role?: AnnexPeerRole;
}

// ── Annex client (controller) types ───────────────────────────────────

export type SatelliteConnectionState = 'disconnected' | 'discovering' | 'connecting' | 'connected';

export interface SatelliteConnection {
  id: string;
  alias: string;
  icon: string;
  color: string;
  fingerprint: string;
  state: SatelliteConnectionState;
  host: string;
  mainPort: number;
  pairingPort: number;
  snapshot: SatelliteSnapshot | null;
  lastError: string | null;
}

/** Summary of an installed plugin sent in the satellite snapshot. */
export interface SnapshotPluginSummary {
  id: string;
  name: string;
  version: string;
  scope: 'project' | 'app' | 'dual';
  contributes?: unknown;
  annexEnabled: boolean;
}

export interface SatelliteSnapshot {
  projects: Project[];
  agents: Record<string, Agent[]>;
  quickAgents: Record<string, unknown[]>;
  theme: unknown;
  orchestrators: unknown;
  pendingPermissions: unknown[];
  lastSeq: number;
  plugins?: SnapshotPluginSummary[];
  agentsMeta?: unknown;
  protocolVersion?: number;
  /** Project icon data URLs keyed by project ID. */
  projectIcons?: Record<string, string>;
  /** Agent icon data URLs keyed by agent ID. */
  agentIcons?: Record<string, string>;
  /** Per-project canvas state keyed by satellite project ID. */
  canvasState?: Record<string, { canvases: unknown[]; activeCanvasId: string }>;
  /** App-level (global) canvas state from the satellite. */
  appCanvasState?: { canvases: unknown[]; activeCanvasId: string } | null;
  /** Whether the satellite session is currently paused. */
  sessionPaused?: boolean;
  /** Group projects from the satellite. */
  groupProjects?: unknown[];
  /** Bulletin digests per group project ID. */
  bulletinDigests?: Record<string, unknown[]>;
  /** Group project members per group project ID. */
  groupProjectMembers?: Record<string, Array<{ agentId: string; agentName: string; status: string }>>;
}

// --- Auto-update types ---

export type UpdateState = 'idle' | 'checking' | 'downloading' | 'ready' | 'error';

export interface UpdateArtifact {
  url: string;
  sha256: string;
  size?: number;
}

export interface UpdateManifest {
  version: string;
  releaseDate: string;
  releaseNotes?: string;
  releaseMessage?: string;
  mandatory?: boolean;
  artifacts: Record<string, UpdateArtifact>;
}

export interface UpdateStatus {
  state: UpdateState;
  availableVersion: string | null;
  releaseNotes: string | null;
  releaseMessage: string | null;
  downloadProgress: number;  // 0-100
  error: string | null;
  downloadPath: string | null;
  artifactUrl: string | null;
  /** True when a previous apply attempt for this version was detected on startup */
  applyAttempted: boolean;
}

export interface UpdateSettings {
  autoUpdate: boolean;
  previewChannel: boolean;
  lastCheck: string | null;
  dismissedVersion: string | null;
  lastSeenVersion: string | null;
}

export interface MarketplaceSettings {
  showBetaPlugins: boolean;
}

export interface PendingReleaseNotes {
  version: string;
  releaseNotes: string;
}

export interface VersionHistoryEntry {
  version: string;
  releaseDate: string;
  releaseMessage: string;
  releaseNotes: string;
}

export type VersionHistory = VersionHistoryEntry[];

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
};

export interface LogEntry {
  ts: string;
  ns: string;
  level: LogLevel;
  msg: string;
  projectId?: string;
  meta?: Record<string, unknown>;
}

export type LogRetention = 'low' | 'medium' | 'high' | 'unlimited';

export interface LogRetentionConfig {
  retentionDays: number;
  maxTotalBytes: number;
}

export const LOG_RETENTION_TIERS: Record<LogRetention, LogRetentionConfig> = {
  low:       { retentionDays: 3,  maxTotalBytes: 50  * 1024 * 1024 },
  medium:    { retentionDays: 7,  maxTotalBytes: 200 * 1024 * 1024 },
  high:      { retentionDays: 30, maxTotalBytes: 500 * 1024 * 1024 },
  unlimited: { retentionDays: 0,  maxTotalBytes: 0 },
};

export interface LoggingSettings {
  enabled: boolean;
  namespaces: Record<string, boolean>;
  retention: LogRetention;
  minLogLevel: LogLevel;
}

/** Built-in theme IDs. Plugin themes use arbitrary string IDs prefixed with `plugin:`. */
export type BuiltinThemeId =
  | 'catppuccin-mocha'
  | 'catppuccin-latte'
  | 'solarized-dark'
  | 'terminal'
  | 'nord'
  | 'dracula'
  | 'tokyo-night'
  | 'gruvbox-dark'
  | 'cyberpunk';

/** Theme IDs — builtin themes plus any plugin-contributed themes. */
export type ThemeId = BuiltinThemeId | (string & {});

export interface ThemeColors {
  base: string;
  mantle: string;
  crust: string;
  text: string;
  subtext0: string;
  subtext1: string;
  surface0: string;
  surface1: string;
  surface2: string;
  accent: string;
  link: string;
  /** Semantic notification colors — WCAG AA compliant against base */
  warning: string;
  error: string;
  info: string;
  success: string;
}

export interface HljsColors {
  keyword: string;
  string: string;
  number: string;
  comment: string;
  function: string;
  type: string;
  variable: string;
  regexp: string;
  tag: string;
  attribute: string;
  symbol: string;
  meta: string;
  addition: string;
  deletion: string;
  property: string;
  punctuation: string;
}

export interface TerminalColors {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionForeground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface ThemeFonts {
  /** UI font family (applied to body and all UI elements). */
  ui?: string;
  /** Monospace font family (applied to code, pre, kbd, terminal). */
  mono?: string;
}

export interface ThemeGradients {
  /** CSS gradient applied to the page background. */
  background?: string;
  /** CSS gradient for elevated surface elements. */
  surface?: string;
  /** CSS gradient for accent/highlight elements. */
  accent?: string;
}

export interface ThemeDefinition {
  id: ThemeId;
  name: string;
  type: 'dark' | 'light';
  colors: ThemeColors;
  hljs: HljsColors;
  terminal: TerminalColors;
  fontOverride?: string;
  /** Custom font families (experimental). */
  fonts?: ThemeFonts;
  /** CSS gradients (experimental). */
  gradients?: ThemeGradients;
}

export interface GitStatusFile {
  path: string;
  origPath?: string;  // For renames/copies: the original path
  status: string;
  staged: boolean;
}

export interface GitLogEntry {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  date: string;
}

export interface GitInfo {
  branch: string;
  branches: string[];
  status: GitStatusFile[];
  log: GitLogEntry[];
  hasGit: boolean;
  ahead: number;
  behind: number;
  remote: string;
  stashCount: number;
  hasConflicts: boolean;
}

export interface GitOpResult {
  ok: boolean;
  message: string;
}

export interface GitWorktreeEntry {
  /** Absolute path to the worktree directory. */
  path: string;
  /** Short label for display (last path segment). */
  label: string;
  /** Current branch checked out in this worktree (empty string if detached). */
  branch: string;
  /** Whether this is the main/bare worktree. */
  isBare: boolean;
}

export interface GitCommitFileEntry {
  path: string;
  status: string;
  origPath?: string;
}

export interface GitCommitDetail {
  hash: string;
  files: GitCommitFileEntry[];
}

export interface McpServerEntry {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  scope: 'project' | 'global';
}

export interface SkillEntry {
  name: string;
  path: string;
  hasReadme: boolean;
}

export interface AgentTemplateEntry {
  name: string;
  path: string;
  hasReadme: boolean;
}

export type HookEventKind = 'pre_tool' | 'post_tool' | 'tool_error' | 'stop' | 'notification' | 'permission_request' | 'permission_resolved';

export interface AgentHookEvent {
  kind: HookEventKind;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  message?: string;
  /** Human-readable verb for the tool, resolved by the provider (e.g. "Editing file") */
  toolVerb?: string;
  timestamp: number;
}

export interface SpawnAgentParams {
  agentId: string;
  projectPath: string;
  cwd: string;
  kind: AgentKind;
  model?: string;
  mission?: string;
  systemPrompt?: string;
  allowedTools?: string[];
  orchestrator?: OrchestratorId;
  freeAgentMode?: boolean;
  /** When true, attempt to resume the previous CLI session instead of starting fresh */
  resume?: boolean;
  /** Specific session ID to resume (provider-specific format) */
  sessionId?: string;
  /** Permission mode override for resume (preserves pre-restart mode) */
  permissionMode?: FreeAgentPermissionMode;
}

export type AgentDetailedState = 'idle' | 'working' | 'needs_permission' | 'tool_error';

export interface AgentDetailedStatus {
  state: AgentDetailedState;
  message: string;
  toolName?: string;
  timestamp: number;
}

// ── Annex structured event forwarding ──────────────────────────────────

export interface AnnexStructuredMessage {
  type: 'structured_event';
  agentId: string;
  event: import('./structured-events').StructuredEvent;
}

export interface AnnexApprovalResponse {
  type: 'permission_response';
  agentId: string;
  requestId: string;
  approved: boolean;
  reason?: string;
}

export interface WorktreeStatus {
  isValid: boolean;
  branch: string;
  uncommittedFiles: GitStatusFile[];
  unpushedCommits: GitLogEntry[];
  hasRemote: boolean;
}

export interface DeleteResult {
  ok: boolean;
  message: string;
}

// ── Hub state sync (main window ↔ pop-out windows) ────────────────────

export type HubMutation =
  | { type: 'split'; paneId: string; direction: 'horizontal' | 'vertical'; position: 'before' | 'after' }
  | { type: 'close'; paneId: string }
  | { type: 'assign'; paneId: string; agentId: string | null; projectId?: string }
  | { type: 'swap'; id1: string; id2: string }
  | { type: 'resize'; splitId: string; ratio: number }
  | { type: 'zoom'; paneId: string }
  | { type: 'focus'; paneId: string };

export interface HubStateSnapshot {
  hubId: string;
  paneTree: unknown; // PaneNode — kept as unknown to avoid circular dependency
  focusedPaneId: string;
  zoomedPaneId: string | null;
}

// ── Canvas state sync (main window ↔ pop-out windows) ─────────────────

export type CanvasMutation =
  | { type: 'addView'; viewType: string; position: { x: number; y: number } }
  | { type: 'addPluginView'; pluginId: string; qualifiedType: string; label: string; position: { x: number; y: number }; defaultSize?: { width: number; height: number } }
  | { type: 'removeView'; viewId: string }
  | { type: 'moveView'; viewId: string; position: { x: number; y: number } }
  | { type: 'moveViews'; positions: Record<string, { x: number; y: number }> }
  | { type: 'resizeView'; viewId: string; size: { width: number; height: number } }
  | { type: 'focusView'; viewId: string }
  | { type: 'updateView'; viewId: string; updates: Record<string, unknown> }
  | { type: 'setViewport'; viewport: { panX: number; panY: number; zoom: number } }
  | { type: 'zoomView'; viewId: string | null }
  | { type: 'selectView'; viewId: string | null }
  // Canvas tab management (for pop-out + annex sync)
  | { type: 'addCanvas' }
  | { type: 'removeCanvas'; canvasId: string }
  | { type: 'renameCanvas'; canvasId: string; name: string }
  | { type: 'setActiveCanvas'; canvasId: string }
  // Zone operations
  | { type: 'removeZone'; zoneId: string; removeContents: boolean }
  | { type: 'updateZoneTheme'; zoneId: string; themeId: string };

export interface CanvasStateSnapshot {
  canvasId: string;
  name: string;
  views: unknown[]; // CanvasView[] — kept as unknown to avoid circular dependency
  viewport: { panX: number; panY: number; zoom: number };
  nextZIndex: number;
  zoomedViewId: string | null;
  selectedViewId?: string | null;
  /** Project context for annex canvas sync (absent in local-only broadcasts). */
  projectId?: string;
  /** Storage scope: 'global' for app mode, 'project' for project mode. */
  scope?: string;
  /** All canvas tab metadata — enables tab sync for annex controllers. */
  allCanvasTabs?: Array<{ id: string; name: string }>;
  /** Active canvas tab ID on the source — enables tab sync for annex controllers. */
  activeCanvasId?: string;
  /** Wire definitions for remote canvas sync — ensures wires are visible on the controller. */
  wireDefinitions?: Array<{
    agentId: string;
    targetId: string;
    targetKind: string;
    label: string;
    agentName?: string;
    targetName?: string;
    projectName?: string;
    instructions?: Record<string, string>;
    disabledTools?: string[];
  }>;
}

// --- Session Resume on Update types ---

export type ResumeStrategy = 'auto' | 'manual';

export interface RestartSessionEntry {
  agentId: string;
  agentName: string;
  projectPath: string;
  orchestrator: OrchestratorId;
  sessionId: string | null;
  resumeStrategy: ResumeStrategy;
  worktreePath?: string;
  kind: AgentKind;
  mission?: string;
  model?: string;
  permissionMode?: FreeAgentPermissionMode;
  /** Whether the agent was running in free-agent (dangerously skip permissions) mode */
  freeAgentMode?: boolean;
}

export interface RestartSessionState {
  version: number;
  capturedAt: string;
  appVersion: string;
  sessions: RestartSessionEntry[];
}

export interface LiveAgentInfo {
  agentId: string;
  projectPath: string;
  orchestrator: OrchestratorId;
  runtime: string;
  isWorking: boolean;
  lastActivity: number | null;
}

