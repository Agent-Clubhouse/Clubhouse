import type { WorktreeStatus } from './types';

export interface DeleteAgentReviewTarget {
  project: string;
  agentId: string;
  name: string;
  worktreePath?: string;
  branch?: string;
  work?: WorktreeStatus;
}

export interface DeleteAgentsReviewItem {
  index: number;
  requestedProject: string;
  requestedAgent: string;
  status: 'ready' | 'refused';
  reason?: string;
  target?: DeleteAgentReviewTarget;
  worktree: 'delete' | 'keep';
  helpers: 'dispose' | 'keep';
  force: boolean;
  helperTargets: DeleteAgentReviewTarget[];
}

export interface DeleteAgentsReview {
  items: DeleteAgentsReviewItem[];
}
