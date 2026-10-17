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
  /** Another agent worked in the same worktree during this turn, so its edits are in this turn's changes too. */
  shared?: boolean;
  /** A revert of this turn can be undone. */
  undoable?: boolean;
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
  /** Untracked files too large to checkpoint; they don't show here and a revert never touches them. */
  skippedLarge?: string[];
  /** Nested git repositories with no commits yet; git can't record them, so they don't show here either. */
  skippedRepos?: string[];
}

export interface RevertResult {
  reverted: string[];
  /** Files changed again after the turn ended; left alone unless forced. */
  conflicts: string[];
  /** Files left alone even when forced, because their current state can't be backed up (large, ignored, a directory or behind a link). */
  skipped: string[];
  /** The change can be undone. */
  undoable?: boolean;
}
