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

export interface DurableAgentConfig {
  id: string;
  name: string;
  color: string;
  localOnly: boolean;
  branch: string;
  worktreePath: string;
  createdAt: string;
  model?: string;
}

export interface ProjectSettings {
  defaultClaudeMd: string;
  quickAgentClaudeMd: string;
}

export interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
}

export type ExplorerTab = 'files' | 'settings' | 'agents' | 'git' | 'terminal' | 'hub';

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
