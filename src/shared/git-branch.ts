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
  /** Commits on the branch since the merge base (only when counts are asked for). */
  ahead?: number;
  /** Uncommitted and untracked files in `git status` (only when counts are asked for). */
  uncommitted?: number;
}

/** Where a branch stands with its remote and pull request. */
export interface PullRequestInfo {
  /** False when the folder isn't in a git work tree. */
  available: boolean;
  branch?: string;
  base?: string;
  /** The remote pushes go to: the branch's upstream, else origin, else the only remote. */
  remote?: string;
  /** There is a remote to push to. */
  hasRemote?: boolean;
  /** The remote is on GitHub, so the review can open a pull request. */
  github?: boolean;
  /** The remote has this branch. */
  pushed?: boolean;
  /** Commits not on the remote's copy of the branch yet; absent when it was never pushed. */
  unpushed?: number;
  /** An open pull request for the branch, when `gh` is installed and signed in. */
  pr?: { url: string; number: number; state: string };
  /** GitHub's page for opening a pull request from this branch. */
  compareUrl?: string;
}

/** One file's change on the branch. An untracked file comes back as its whole text. */
export interface BranchFilePatch {
  patch?: string;
  newText?: string;
  binary?: boolean;
  /** Over 1 MB: not read or diffed. */
  tooLarge?: boolean;
  /** An untracked symbolic link: its target, never followed or read. */
  link?: string;
}
