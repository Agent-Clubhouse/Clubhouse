export interface Project {
  id: string;
  name: string;
  path: string;
  color?: string;  // AGENT_COLORS id (e.g. 'emerald')
  icon?: string;   // filename in ~/.clubhouse/project-icons/
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
  localOnly: boolean;
  worktreePath?: string;
  branch?: string;
  exitCode?: number;
  mission?: string;
  model?: string;
  parentAgentId?: string;
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

export type ConfigItemKey = 'claudeMd' | 'permissions' | 'mcpConfig' | 'skills' | 'agents';
export type OverrideFlags = Record<ConfigItemKey, boolean>;

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

/** A layer of config values. undefined = inherit, null = explicitly cleared. */
export interface ConfigLayer {
  claudeMd?: string | null;
  permissions?: PermissionsConfig | null;
  mcpConfig?: McpConfig | null;
}

export interface QuickAgentDefaults {
  systemPrompt?: string;
  allowedTools?: string[];
  defaultModel?: string;
}

export interface ProjectSettings {
  // Legacy fields (kept for migration)
  defaultClaudeMd?: string;
  quickAgentClaudeMd?: string;
  // New fields
  defaults: ConfigLayer;
  quickOverrides: ConfigLayer;
  defaultSkillsPath?: string;
  defaultAgentsPath?: string;
}

export interface DurableAgentConfig {
  id: string;
  name: string;
  color: string;
  emoji?: string;
  localOnly: boolean;
  branch: string;
  worktreePath: string;
  createdAt: string;
  model?: string;
  overrides: OverrideFlags;
  quickOverrides: OverrideFlags;
  quickConfigLayer: ConfigLayer;
  quickAgentDefaults?: QuickAgentDefaults;
}

export interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
}

export type ExplorerTab = 'files' | 'settings' | 'agents' | 'git' | 'notes' | 'terminal' | 'hub' | 'scheduler';

export interface NotificationSettings {
  enabled: boolean;
  permissionNeeded: boolean;
  agentIdle: boolean;
  agentStopped: boolean;
  agentError: boolean;
  playSound: boolean;
}

export type SettingsSubPage = 'project' | 'notifications';

export interface GitStatusFile {
  path: string;
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

export interface AgentHookEvent {
  eventName: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  timestamp: number;
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

export interface PtySpawnOptions {
  agentId: string;
  projectPath: string;
  claudeArgs?: string[];
}

export interface PtyDataPayload {
  agentId: string;
  data: string;
}

export interface PtyExitPayload {
  agentId: string;
  exitCode: number;
}

export interface SchedulerJob {
  id: string;
  name: string;
  cronExpression: string;  // standard 5-field cron: min hour dom month dow
  agentType: 'durable' | 'quick';
  agentId?: string;        // durable agent config ID
  model?: string;          // for quick agents
  prompt: string;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
}
