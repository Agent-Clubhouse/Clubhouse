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

export type AgentStatus = 'running' | 'sleeping' | 'error';
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
  mission?: string;
  model?: string;
  parentAgentId?: string;
  orchestrator?: OrchestratorId;
  headless?: boolean;
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
}

export interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
}

export type ExplorerTab = string;


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

export type SettingsSubPage = 'project' | 'notifications' | 'logging' | 'display' | 'orchestrators' | 'plugins' | 'plugin-detail' | 'about' | 'updates' | 'whats-new';

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

export type ThemeId =
  | 'catppuccin-mocha'
  | 'catppuccin-latte'
  | 'solarized-dark'
  | 'terminal'
  | 'nord'
  | 'dracula'
  | 'tokyo-night'
  | 'gruvbox-dark';

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


