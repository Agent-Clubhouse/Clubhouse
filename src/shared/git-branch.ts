/** Types for an agent's branch against main (#2032), shared by git-branch.ts (main) and Agent details. */

import type { ChangedFile } from './chat-checkpoints';

export interface BranchChanges {
  /** False when the folder isn't in a git work tree. */
  available: boolean;
  /** The checked-out branch ("HEAD" when detached). */
  branch?: string;
  /** Short name of the base branch ("main"). */
  base?: string;
  /** Commit the branch left the base at. */
  mergeBase?: string;
  /** No main or master branch, or no history in common with it. */
  noBase?: boolean;
  /** Changes since the merge base: committed, uncommitted and untracked. */
  files: ChangedFile[];
  /** Commits on the branch since the merge base. */
  ahead: number;
  /** Entries in `git status`: uncommitted and untracked files. */
  uncommitted: number;
}

/** One file's change on the branch. An untracked file comes back as its whole text. */
export interface BranchFilePatch {
  patch?: string;
  newText?: string;
  binary?: boolean;
}
