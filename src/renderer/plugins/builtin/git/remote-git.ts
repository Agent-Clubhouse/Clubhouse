/**
 * Remote-aware git operations.
 *
 * When the active project is a remote satellite project, git operations are
 * proxied through the annex client HTTPS REST API. For local projects the
 * standard window.clubhouse.git IPC methods are used directly.
 */
import { isRemoteProjectId, parseNamespacedId } from '../../../stores/remoteProjectStore';

export interface RemoteGitOps {
  info(): Promise<any>;
  log(limit: number, offset: number): Promise<any>;
  diff(filePath: string, staged: boolean): Promise<any>;
  commitDiff(hash: string, filePath: string): Promise<any>;
  showCommit(hash: string): Promise<any>;
  stage(filePath: string): Promise<any>;
  unstage(filePath: string): Promise<any>;
  stageAll(): Promise<any>;
  unstageAll(): Promise<any>;
  commit(message: string): Promise<any>;
  push(): Promise<any>;
  pull(): Promise<any>;
  checkout(branch: string): Promise<any>;
  stash(): Promise<any>;
  stashPop(): Promise<any>;
}

/**
 * Create a git operations object that routes to the appropriate backend
 * based on whether the project is local or remote.
 */
export function createGitOps(projectPath: string, projectId?: string): RemoteGitOps {
  if (projectId && isRemoteProjectId(projectId)) {
    const parsed = parseNamespacedId(projectId);
    if (!parsed) throw new Error('Invalid remote project ID');
    const { satelliteId, agentId: origProjectId } = parsed;
    const git = (operation: string, extra?: Record<string, unknown>) =>
      window.clubhouse.annexClient.gitOperation(satelliteId, origProjectId, { operation, ...extra });

    return {
      info: () => git('info'),
      log: (limit, offset) => git('log', { limit, offset }),
      diff: (file, staged) => git('diff', { file, staged }),
      commitDiff: (hash, file) => git('commit-diff', { hash, file }),
      showCommit: (hash) => git('show-commit', { hash }),
      stage: (path) => git('stage', { path }),
      unstage: (path) => git('unstage', { path }),
      stageAll: () => git('stage-all'),
      unstageAll: () => git('unstage-all'),
      commit: (message) => git('commit', { message }),
      push: () => git('push'),
      pull: () => git('pull'),
      checkout: (branch) => git('checkout', { branch }),
      stash: () => git('stash'),
      stashPop: () => git('stash-pop'),
    };
  }

  // Local operations
  return {
    info: () => window.clubhouse.git.info(projectPath),
    log: (limit, offset) => window.clubhouse.git.log(projectPath, limit, offset),
    diff: (file, staged) => window.clubhouse.git.diff(projectPath, file, staged),
    commitDiff: (hash, file) => window.clubhouse.git.commitDiff(projectPath, hash, file),
    showCommit: (hash) => window.clubhouse.git.showCommit(projectPath, hash),
    stage: (path) => window.clubhouse.git.stage(projectPath, path),
    unstage: (path) => window.clubhouse.git.unstage(projectPath, path),
    stageAll: () => window.clubhouse.git.stageAll(projectPath),
    unstageAll: () => window.clubhouse.git.unstageAll(projectPath),
    commit: (message) => window.clubhouse.git.commit(projectPath, message),
    push: () => window.clubhouse.git.push(projectPath),
    pull: () => window.clubhouse.git.pull(projectPath),
    checkout: (branch) => window.clubhouse.git.checkout(projectPath, branch),
    stash: () => window.clubhouse.git.stash(projectPath),
    stashPop: () => window.clubhouse.git.stashPop(projectPath),
  };
}
