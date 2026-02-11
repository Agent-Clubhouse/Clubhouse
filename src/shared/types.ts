export interface Project {
  id: string;
  name: string;
  path: string;
}

export type AgentStatus = 'running' | 'sleeping' | 'stopped' | 'error';
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
}

export interface DurableAgentConfig {
  id: string;
  name: string;
  color: string;
  localOnly: boolean;
  branch: string;
  worktreePath: string;
  createdAt: string;
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

export type ExplorerTab = 'files' | 'settings' | 'agents' | 'git';

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
