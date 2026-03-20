import {
  Agent,
  AgentStatus,
  AgentDetailedStatus,
  AgentHookEvent,
  DurableAgentConfig,
  DeleteResult,
} from '../../../shared/types';

export type DeleteMode = 'commit-push' | 'cleanup-branch' | 'save-patch' | 'force' | 'unregister';

export interface AgentUISlice {
  activeAgentId: string | null;
  agentSettingsOpenFor: string | null;
  deleteDialogAgent: string | null;
  configChangesDialogAgent: string | null;
  configChangesProjectPath: string | null;
  /** Agent ID that should be prompted for a session name (set on quit if setting enabled) */
  sessionNamePromptFor: string | null;
  projectActiveAgent: Record<string, string | null>;
  setActiveAgent: (id: string | null, projectId?: string) => void;
  restoreProjectAgent: (projectId: string) => void;
  openAgentSettings: (agentId: string) => void;
  closeAgentSettings: () => void;
  openDeleteDialog: (agentId: string) => void;
  closeDeleteDialog: () => void;
  openConfigChangesDialog: (agentId: string, projectPath: string) => void;
  closeConfigChangesDialog: () => void;
  setSessionNamePrompt: (agentId: string | null) => void;
}

export interface AgentCrudSlice {
  agents: Record<string, Agent>;
  removeAgent: (id: string) => void;
  renameAgent: (id: string, newName: string, projectPath: string) => Promise<void>;
  updateAgent: (
    id: string,
    updates: { name?: string; color?: string; icon?: string | null },
    projectPath: string,
  ) => Promise<void>;
  reorderAgents: (projectPath: string, orderedIds: string[]) => Promise<void>;
  loadDurableAgents: (projectId: string, projectPath: string) => Promise<void>;
}

export interface AgentLifecycleSlice {
  /** Track agents that were user-cancelled (not naturally completed) */
  cancelledAgentIds: Record<string, true>;
  spawnQuickAgent: (
    projectId: string,
    projectPath: string,
    mission: string,
    model?: string,
    parentAgentId?: string,
    orchestrator?: string,
    freeAgentMode?: boolean,
  ) => Promise<string>;
  spawnDurableAgent: (
    projectId: string,
    projectPath: string,
    config: DurableAgentConfig,
    resume: boolean,
    mission?: string,
  ) => Promise<string>;
  killAgent: (id: string, projectPath?: string) => Promise<void>;
  deleteDurableAgent: (id: string, projectPath: string) => Promise<void>;
  /** Register a placeholder agent in 'creating' state while worktree is set up. Returns temp ID. */
  registerCreatingAgent: (
    projectId: string,
    name: string,
    color: string,
    orchestrator?: string,
    freeAgentMode?: boolean,
  ) => string;
  /** Clear the resuming flag for an agent (called when session replay finishes) */
  clearResuming: (id: string) => void;
  executeDelete: (mode: DeleteMode, projectPath: string) => Promise<DeleteResult>;
  resumingAgents: Record<string, import('../../features/app/ResumeBanner').ResumeStatus>;
  setResumeStatus: (agentId: string, status: import('../../features/app/ResumeBanner').ResumeStatus) => void;
  clearResumingAgents: () => void;
}

export interface AgentStatusSlice {
  agentActivity: Record<string, number>; // agentId -> last data timestamp
  agentSpawnedAt: Record<string, number>; // agentId -> spawn timestamp
  agentTerminalAt: Record<string, number>; // agentId -> terminal timestamp
  agentDetailedStatus: Record<string, AgentDetailedStatus>;
  updateAgentStatus: (
    id: string,
    status: AgentStatus,
    exitCode?: number,
    errorMessage?: string,
    lastOutput?: string,
  ) => void;
  handleHookEvent: (agentId: string, event: AgentHookEvent) => void;
  clearStaleStatuses: () => void;
  recordActivity: (id: string) => void;
  isAgentActive: (id: string) => boolean;
}

export interface AgentIconSlice {
  agentIcons: Record<string, string>; // agentId -> data URL
  pickAgentIcon: (agentId: string, projectPath: string) => Promise<string | null>;
  saveAgentIcon: (agentId: string, projectPath: string, dataUrl: string) => Promise<void>;
  removeAgentIcon: (agentId: string, projectPath: string) => Promise<void>;
  loadAgentIcon: (agent: Agent) => Promise<void>;
}

export type AgentState = AgentUISlice & AgentCrudSlice & AgentLifecycleSlice & AgentStatusSlice & AgentIconSlice;

export type SetAgentState = (
  partial: Partial<AgentState> | ((state: AgentState) => Partial<AgentState> | AgentState),
) => void;

export type GetAgentState = () => AgentState;
