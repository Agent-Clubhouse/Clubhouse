/**
 * Shared types for the Agent Queue system — a task queue that spawns
 * quick agents to execute missions, with structured output persistence.
 */

/** Status of a task in the queue. */
export type AgentQueueTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/** Configuration for an Agent Queue instance. */
export interface AgentQueue {
  id: string;              // "aq_<timestamp>_<random>"
  name: string;
  /** Max concurrent tasks (0 = unlimited). */
  concurrency: number;
  /** Project ID to use when spawning quick agents. */
  projectId?: string;
  /** Project path (resolved from projectId). */
  projectPath?: string;
  /** Orchestrator to use for spawned agents. */
  orchestrator?: string;
  /** Model override for spawned agents. */
  model?: string;
  /** Whether spawned agents run in free-agent mode. */
  freeAgentMode?: boolean;
  /** Automatically create a git worktree for each task. */
  autoWorktree?: boolean;
  createdAt: string;       // ISO 8601
  metadata: Record<string, unknown>;
}

/** A task managed by the Agent Queue. */
export interface AgentQueueTask {
  id: string;              // "aqt_<timestamp>_<random>"
  queueId: string;
  mission: string;
  status: AgentQueueTaskStatus;
  /** The quick agent ID (set once the agent is spawned). */
  agentId?: string;
  /** The agent name (for display). */
  agentName?: string;
  /** Worktree path if autoWorktree was used. */
  worktreePath?: string;
  createdAt: string;       // ISO 8601
  startedAt?: string;      // ISO 8601
  completedAt?: string;    // ISO 8601
  /** Exit code from the quick agent. */
  exitCode?: number;
  /** Cost in USD if available. */
  costUsd?: number;
  /** Duration in milliseconds. */
  durationMs?: number;
  /** Files modified by the agent. */
  filesModified?: string[];
  /** Short summary (< 500 words): outcome, findings, issues. */
  summary?: string;
  /** Detailed output: full reasoning, analysis, step-by-step. */
  detail?: string;
  /** Error message if status is 'failed'. */
  errorMessage?: string;
}

/** Summary view of a task (for list operations). */
export interface AgentQueueTaskSummary {
  id: string;
  queueId: string;
  mission: string;
  status: AgentQueueTaskStatus;
  agentName?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  exitCode?: number;
  /** Whether summary/detail output is available. */
  hasOutput: boolean;
}
