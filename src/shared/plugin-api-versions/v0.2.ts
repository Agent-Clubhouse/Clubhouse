/**
 * Frozen API snapshot for plugin API v0.2.
 *
 * DO NOT MODIFY these interfaces — they are the compile-time contract for
 * plugins targeting engine.api: 0.2. Any structural change here intentionally
 * breaks `tsc --noEmit` so we catch backward-compat regressions before runtime.
 *
 * v0.2 is a strict superset of v0.1, adding: navigation, widgets, context,
 * and enriched agents (kill, resume, listCompleted, etc.).
 */

import type {
  Disposable,
  DirectoryEntry,
  GitStatus,
  GitCommit,
  ProjectInfo,
  CompletedQuickAgentInfo,
  PluginAgentDetailedStatus,
  PluginRenderMode,
  ModelOption,
  PluginAPI,
} from '../plugin-types';
import type React from 'react';

// ── v0.2 scoped types ─────────────────────────────────────────────────

export interface ScopedStorage_V0_2 {
  read(key: string): Promise<unknown>;
  write(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<string[]>;
}

export interface AgentInfo_V0_2 {
  id: string;
  name: string;
  kind: 'durable' | 'quick';
  status: 'running' | 'sleeping' | 'error';
  color: string;
  emoji?: string;
  exitCode?: number;
  mission?: string;
  projectId: string;
  branch?: string;
  model?: string;
  parentAgentId?: string;
}

// ── v0.2 sub-API interfaces ───────────────────────────────────────────

export interface ProjectAPI_V0_2 {
  readonly projectPath: string;
  readonly projectId: string;
  readFile(relativePath: string): Promise<string>;
  writeFile(relativePath: string, content: string): Promise<void>;
  deleteFile(relativePath: string): Promise<void>;
  fileExists(relativePath: string): Promise<boolean>;
  listDirectory(relativePath?: string): Promise<DirectoryEntry[]>;
}

export interface ProjectsAPI_V0_2 {
  list(): ProjectInfo[];
  getActive(): ProjectInfo | null;
}

export interface GitAPI_V0_2 {
  status(): Promise<GitStatus[]>;
  log(limit?: number): Promise<GitCommit[]>;
  currentBranch(): Promise<string>;
  diff(filePath: string, staged?: boolean): Promise<string>;
}

export interface StorageAPI_V0_2 {
  project: ScopedStorage_V0_2;
  projectLocal: ScopedStorage_V0_2;
  global: ScopedStorage_V0_2;
}

export interface UIAPI_V0_2 {
  showNotice(message: string): void;
  showError(message: string): void;
  showConfirm(message: string): Promise<boolean>;
  showInput(prompt: string, defaultValue?: string): Promise<string | null>;
}

export interface CommandsAPI_V0_2 {
  register(commandId: string, handler: (...args: unknown[]) => void | Promise<void>): Disposable;
  execute(commandId: string, ...args: unknown[]): Promise<void>;
}

export interface EventsAPI_V0_2 {
  on(event: string, handler: (...args: unknown[]) => void): Disposable;
}

export interface SettingsAPI_V0_2 {
  get<T = unknown>(key: string): T | undefined;
  getAll(): Record<string, unknown>;
  onChange(callback: (key: string, value: unknown) => void): Disposable;
}

export interface ModelOption_V0_2 {
  id: string;
  label: string;
}

export interface AgentsAPI_V0_2 {
  list(): AgentInfo_V0_2[];
  runQuick(mission: string, options?: { model?: string; systemPrompt?: string; projectId?: string }): Promise<string>;
  kill(agentId: string): Promise<void>;
  resume(agentId: string): Promise<void>;
  listCompleted(projectId?: string): CompletedQuickAgentInfo[];
  dismissCompleted(projectId: string, agentId: string): void;
  getDetailedStatus(agentId: string): PluginAgentDetailedStatus | null;
  getModelOptions(projectId?: string): Promise<ModelOption_V0_2[]>;
  onStatusChange(callback: (agentId: string, status: string, prevStatus: string) => void): Disposable;
  onAnyChange(callback: () => void): Disposable;
}

export interface HubAPI_V0_2 {
  refresh(): void;
}

export interface NavigationAPI_V0_2 {
  focusAgent(agentId: string): void;
  setExplorerTab(tabId: string): void;
}

export interface WidgetsAPI_V0_2 {
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

export interface TerminalAPI_V0_2 {
  spawn(sessionId: string, cwd?: string): Promise<void>;
  write(sessionId: string, data: string): void;
  resize(sessionId: string, cols: number, rows: number): void;
  kill(sessionId: string): Promise<void>;
  getBuffer(sessionId: string): Promise<string>;
  onData(sessionId: string, callback: (data: string) => void): Disposable;
  onExit(sessionId: string, callback: (exitCode: number) => void): Disposable;
  ShellTerminal: React.ComponentType<{ sessionId: string; focused?: boolean }>;
}

export interface PluginContextInfo_V0_2 {
  mode: PluginRenderMode;
  projectId?: string;
  projectPath?: string;
}

// ── Composite v0.2 API ────────────────────────────────────────────────

export interface PluginAPI_V0_2 {
  project: ProjectAPI_V0_2;
  projects: ProjectsAPI_V0_2;
  git: GitAPI_V0_2;
  storage: StorageAPI_V0_2;
  ui: UIAPI_V0_2;
  commands: CommandsAPI_V0_2;
  events: EventsAPI_V0_2;
  settings: SettingsAPI_V0_2;
  agents: AgentsAPI_V0_2;
  hub: HubAPI_V0_2;
  navigation: NavigationAPI_V0_2;
  widgets: WidgetsAPI_V0_2;
  terminal: TerminalAPI_V0_2;
  context: PluginContextInfo_V0_2;
}

// ── Compile-time backward-compat guard ────────────────────────────────
// Fails to compile if the current PluginAPI drops or changes any v0.2 member.
type _V0_2_BackCompat = PluginAPI extends PluginAPI_V0_2 ? true : never;
const _v0_2_check: _V0_2_BackCompat = true;
void _v0_2_check;
