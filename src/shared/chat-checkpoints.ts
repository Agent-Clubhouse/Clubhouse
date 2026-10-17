/** Types shared by the checkpoint service (main) and the Changes panel (renderer). */

export interface CheckpointTurn {
  sessionId: string;
  turnId: string;
  startedAt: number;
  endedAt?: number;
  /** Checkpoint commit at turn start. */
  start: string;
  /** Checkpoint commit at turn end; absent while the turn runs. */
  end?: string;
}

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: ChangeStatus;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface ChangesResult {
  /** False when the agent's directory isn't a git work tree. */
  available: boolean;
  files: ChangedFile[];
  /** Unified diff for the requested file. */
  patch?: string;
  /** True when comparing against the working tree (turn still running, or a session view). */
  live?: boolean;
}

export interface RevertResult {
  reverted: string[];
  /** Files changed again after the turn ended; left alone unless forced. */
  conflicts: string[];
}
