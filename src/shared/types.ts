export type OrchestratorId = 'claude-code' | (string & {});

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
  emoji?: string;
  worktreePath?: string;
  branch?: string;
  exitCode?: number;
  mission?: string;
  model?: string;
  parentAgentId?: string;
  orchestrator?: OrchestratorId;
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
  emoji?: string;
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


export interface NotificationSettings {
  enabled: boolean;
  permissionNeeded: boolean;
  agentIdle: boolean;
  agentStopped: boolean;
  agentError: boolean;
  playSound: boolean;
}

export type SettingsSubPage = 'project' | 'notifications' | 'display' | 'orchestrators';

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


