export interface ImportInput {
  url: string;
  destination: string;
  branch?: string;
}

export interface RemoteIdentity {
  url: string;
  defaultBranch: string;
  branch: string;
  commit: string;
  headCommit: string;
}

export interface ImportPlan extends RemoteIdentity {
  id: string;
  agentId: string;
  destination: string;
  parent: string;
  parentIdentity: string;
  createdAt: number;
  expiresAt: number;
  effects: readonly string[];
}

export type ImportPhase = 'reserved' | 'initializing' | 'fetching' | 'checking_out' | 'cloned' | 'registering'
  | 'completed' | 'partial' | 'cancelled' | 'interrupted' | 'failed';

export interface ImportAgentCreation {
  key: string;
  requestId: string;
  phase: 'reserved' | 'completed' | 'failed';
  agentId?: string;
}

export interface ImportReceipt {
  id: string;
  plan: ImportPlan;
  phase: ImportPhase;
  updatedAt: number;
  directoryIdentity?: string;
  cloneCompleted: boolean;
  projectId?: string;
  gitignore?: 'updated' | 'unchanged' | 'failed';
  reason?: string;
  failedAt?: ImportPhase;
  progress?: number;
  /** The import itself never creates or starts an agent. The separate builder outcome is below. */
  agentCreated: false;
  agentStarted: false;
  agentCreation?: ImportAgentCreation;
}

export interface ImportStatus extends ImportReceipt {
  message?: string;
  agentRecovery?: string;
  recovery: string;
}

export type ImportUserResult<T> = { ok: true; value: T } | { ok: false; reason: string; message: string };

export interface ImportedAgentReview {
  importId: string;
  projectId: string;
  projectPath: string;
  name: string;
  templateId?: string;
  templateName?: string;
  settings: import('./managed-agents-types').ManagedTemplateSettings;
  setup?: Omit<import('./managed-agents-types').ManagedAgentSetup, 'version'>;
  connectToDispatcher: boolean;
  effects: readonly string[];
}
