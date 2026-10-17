/** Types for an agent's branch against main (#2032), shared by git-service.ts (main) and Agent details. */

import type { ChangedFile } from './chat-checkpoints';

/** Branch views don't detect renames: a moved file shows as deleted and added. */
export type BranchFileStatus = Exclude<ChangedFile['status'], 'renamed'>;

export interface BranchChanges {
  /** False when the folder isn't in a git work tree. */
  available: boolean;
  /** The checked-out branch, or the short sha of a detached HEAD. */
  branch?: string;
  /** Short name of the main line ("main"). */
  base?: string;
  /** Commit the branch left the main line at. */
  mergeBase?: string;
  /** No main line (origin/HEAD, main or master) with history in common. */
  noBase?: boolean;
  /** Changes since the merge base: committed, uncommitted and untracked. */
  files: ChangedFile[];
}

/** One file's change on the branch. An untracked file comes back as its whole text. */
export interface BranchFilePatch {
  patch?: string;
  newText?: string;
  binary?: boolean;
  /** Over 1 MB: not read or diffed. */
  tooLarge?: boolean;
}
