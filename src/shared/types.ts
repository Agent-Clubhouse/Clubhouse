export interface ArchInfo {
  arch: string;
  platform: string;
  rosetta: boolean;
}

export type OrchestratorId = 'claude-code' | (string & {});

export interface ProviderCapabilities {
  headless: boolean;
  structuredOutput: boolean;
  hooks: boolean;
  sessionResume: boolean;
  permissions: boolean;
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
  displayName?: string; // user-set display name (overrides `name` in UI)
  orchestrator?: OrchestratorId;
}

export type AgentStatus = 'running' | 'sleeping' | 'creating' | 'error';
export type AgentKind = 'durable' | 'quick';

export interface Agent {
  id: string;
  projectId: string;
  name: string;
  kind: AgentKind;
  status: AgentStatus;
  color: string;
  icon?: string;         // filename in ~/.clubhouse/agent-icons/
  worktreePath?: string;
  branch?: string;
  exitCode?: number;
  errorMessage?: string;
  mission?: string;
  model?: string;
  parentAgentId?: string;
  orchestrator?: OrchestratorId;
  headless?: boolean;
  freeAgentMode?: boolean;
  /** Set when the agent is resuming a previous CLI session (spinner overlay) */
  resuming?: boolean;
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
  branch?: string;
  worktreePath?: string;
  createdAt: string;
  model?: string;
  quickAgentDefaults?: QuickAgentDefaults;
  orchestrator?: OrchestratorId;
  freeAgentMode?: boolean;
  clubhouseModeOverride?: boolean;
  /** Last CLI session ID, used to resume previous session on wake */
  lastSessionId?: string;
  /** History of CLI sessions for this agent */
  sessionHistory?: SessionInfo[];
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

export interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
  /** In ADO mode, path to the sibling .md index page for this folder */
  indexPath?: string;
}

export type ExplorerTab = string;


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

export type SettingsSubPage = 'project' | 'notifications' | 'sounds' | 'logging' | 'display' | 'orchestrators' | 'profiles' | 'plugins' | 'plugin-detail' | 'about' | 'updates' | 'whats-new' | 'getting-started' | 'keyboard-shortcuts' | 'annex';

// --- Annex (LAN monitoring) types ---

export interface AnnexSettings {
  enabled: boolean;
  deviceName: string;
}

export interface AnnexStatus {
  advertising: boolean;
  port: number;
  pin: string;
  connectedCount: number;
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
}

export interface UpdateSettings {
  autoUpdate: boolean;
  previewChannel: boolean;
  lastCheck: string | null;
  dismissedVersion: string | null;
  lastSeenVersion: string | null;
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
  | 'gruvbox-dark';

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

export interface ThemeDefinition {
  id: ThemeId;
  name: string;
  type: 'dark' | 'light';
  colors: ThemeColors;
  hljs: HljsColors;
  terminal: TerminalColors;
  fontOverride?: string;
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

export type HookEventKind = 'pre_tool' | 'post_tool' | 'tool_error' | 'stop' | 'notification' | 'permission_request';

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
}

export type AgentDetailedState = 'idle' | 'working' | 'needs_permission' | 'tool_error';

export interface AgentDetailedStatus {
  state: AgentDetailedState;
  message: string;
  toolName?: string;
  timestamp: number;
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

