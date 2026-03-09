import { execFile as nodeExecFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { GitInfo, GitStatusFile, GitLogEntry, GitOpResult } from '../../shared/types';
import { appLog } from './log-service';

// Conflict status codes from git porcelain format
const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/** Reject branch names that could be misinterpreted as git flags or contain dangerous chars. */
function validateBranchName(name: string): void {
  if (name.startsWith('-')) {
    throw new Error(`Invalid branch name: must not start with '-'`);
  }
  if (name.includes('\0')) {
    throw new Error('Invalid branch name: must not contain null bytes');
  }
}

/** Reject file paths with traversal sequences or null bytes. */
function validateFilePath(filePath: string): void {
  if (path.isAbsolute(filePath)) {
    throw new Error('Invalid file path: must be relative');
  }
  const normalized = path.normalize(filePath);
  if (normalized.startsWith('..')) {
    throw new Error('Invalid file path: must not traverse above repository root');
  }
  if (filePath.includes('\0')) {
    throw new Error('Invalid file path: must not contain null bytes');
  }
}

function gitExec(args: string[], cwd: string, timeout = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    nodeExecFile('git', args, { cwd, encoding: 'utf-8', timeout }, (error, stdout, stderr) => {
      if (error) {
        (error as any).stderr = stderr;
        reject(error);
      } else {
        resolve(stdout as string);
      }
    });
  });
}

async function run(args: string[], cwd: string): Promise<string> {
  try {
    const output = await gitExec(args, cwd);
    return output.trim();
  } catch (err: any) {
    const msg = err?.stderr?.toString?.() || err?.message || 'Unknown error';
    appLog('core:git', 'warn', 'Git command failed', {
      meta: { cmd: `git ${args.slice(0, 2).join(' ')}`, cwd, error: msg.trim() },
    });
    return '';
  }
}

async function runResult(args: string[], cwd: string, timeout = 30000): Promise<GitOpResult> {
  try {
    const output = await gitExec(args, cwd, timeout);
    return { ok: true, message: output.trim() };
  } catch (err: any) {
    const msg = err?.stderr?.toString?.() || err?.message || 'Unknown error';
    appLog('core:git', 'warn', 'Git operation failed', {
      meta: { cmd: `git ${args.slice(0, 2).join(' ')}`, cwd, error: msg.trim() },
    });
    return { ok: false, message: msg.trim() };
  }
}

export async function getGitInfo(dirPath: string): Promise<GitInfo> {
  const hasGit = fs.existsSync(path.join(dirPath, '.git'));
  if (!hasGit) {
    return { branch: '', branches: [], status: [], log: [], hasGit: false, ahead: 0, behind: 0, remote: '', stashCount: 0, hasConflicts: false };
  }

  // Run independent git commands in parallel
  const [branchRaw, branchesRaw, statusRaw, logRaw, remoteRaw, stashRaw] = await Promise.all([
    run(['rev-parse', '--abbrev-ref', 'HEAD'], dirPath),
    run(['branch', '--no-color'], dirPath),
    run(['status', '--porcelain', '-uall'], dirPath),
    run(['log', '--oneline', '--format=%H|||%h|||%s|||%an|||%ar', '-20'], dirPath),
    run(['remote'], dirPath),
    run(['stash', 'list'], dirPath),
  ]);

  const branch = branchRaw || 'HEAD';

  const branches = branchesRaw
    .split('\n')
    .map((b) => b.replace(/^\*?\s+/, '').trim())
    .filter(Boolean);

  let hasConflicts = false;
  const status: GitStatusFile[] = statusRaw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const staged = line[0] !== ' ' && line[0] !== '?';
      const statusCode = line.slice(0, 2).trim();
      let filePath = line.slice(3);
      let origPath: string | undefined;

      // Renames show as "R  old-name -> new-name"
      if (statusCode.startsWith('R') || statusCode.startsWith('C')) {
        const arrowIdx = filePath.indexOf(' -> ');
        if (arrowIdx !== -1) {
          origPath = filePath.slice(0, arrowIdx);
          filePath = filePath.slice(arrowIdx + 4);
        }
      }

      if (CONFLICT_CODES.has(statusCode)) {
        hasConflicts = true;
      }

      return { path: filePath, status: statusCode, staged, ...(origPath ? { origPath } : {}) };
    });

  const log: GitLogEntry[] = logRaw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, shortHash, subject, author, date] = line.split('|||');
      return { hash, shortHash, subject, author, date };
    });

  // Remote tracking info
  const remote = remoteRaw.split('\n')[0] || '';
  let ahead = 0;
  let behind = 0;
  if (remote) {
    const abRaw = await run(['rev-list', '--left-right', '--count', `${remote}/${branch}...HEAD`], dirPath);
    if (abRaw) {
      const parts = abRaw.split(/\s+/);
      behind = parseInt(parts[0], 10) || 0;
      ahead = parseInt(parts[1], 10) || 0;
    }
  }

  // Stash count
  const stashCount = stashRaw ? stashRaw.split('\n').filter(Boolean).length : 0;

  return { branch, branches, status, log, hasGit, ahead, behind, remote, stashCount, hasConflicts };
}

export async function checkout(dirPath: string, branchName: string): Promise<GitOpResult> {
  validateBranchName(branchName);
  return runResult(['checkout', branchName], dirPath);
}

export async function stage(dirPath: string, filePath: string): Promise<GitOpResult> {
  validateFilePath(filePath);
  return runResult(['add', '--', filePath], dirPath);
}

export async function unstage(dirPath: string, filePath: string): Promise<GitOpResult> {
  validateFilePath(filePath);
  return runResult(['reset', 'HEAD', '--', filePath], dirPath);
}

export async function commit(dirPath: string, message: string): Promise<GitOpResult> {
  return runResult(['commit', '-m', message], dirPath);
}

export async function push(dirPath: string): Promise<GitOpResult> {
  const info = await getGitInfo(dirPath);
  if (!info.remote) {
    return { ok: false, message: 'No remote configured' };
  }
  return runResult(['push', info.remote, info.branch], dirPath);
}

export async function getFileDiff(
  dirPath: string,
  filePath: string,
  staged: boolean
): Promise<{ original: string; modified: string }> {
  validateFilePath(filePath);

  // Get the HEAD version (empty for new/untracked files)
  let original = '';
  try {
    original = await gitExec(['show', `HEAD:${filePath}`], dirPath);
  } catch {
    // File doesn't exist in HEAD (new/untracked) — leave empty
  }

  let modified = '';
  if (staged) {
    // Staged version from the index
    try {
      modified = await gitExec(['show', `:${filePath}`], dirPath);
    } catch {
      modified = '';
    }
  } else {
    // Working tree version from disk
    try {
      modified = await fs.promises.readFile(path.join(dirPath, filePath), 'utf-8');
    } catch {
      modified = '';
    }
  }

  return { original, modified };
}

export async function pull(dirPath: string): Promise<GitOpResult> {
  const info = await getGitInfo(dirPath);
  if (!info.remote) {
    return { ok: false, message: 'No remote configured' };
  }
  return runResult(['pull', info.remote, info.branch], dirPath);
}

export async function stageAll(dirPath: string): Promise<GitOpResult> {
  return runResult(['add', '-A'], dirPath);
}

export async function unstageAll(dirPath: string): Promise<GitOpResult> {
  return runResult(['reset', 'HEAD'], dirPath);
}

export async function discardFile(dirPath: string, filePath: string, isUntracked: boolean): Promise<GitOpResult> {
  validateFilePath(filePath);
  if (isUntracked) {
    // Remove untracked file from disk
    try {
      await fs.promises.unlink(path.join(dirPath, filePath));
      return { ok: true, message: 'Deleted untracked file' };
    } catch (err: any) {
      return { ok: false, message: err?.message || 'Failed to delete file' };
    }
  }
  return runResult(['restore', '--', filePath], dirPath);
}

export async function createBranch(dirPath: string, branchName: string): Promise<GitOpResult> {
  validateBranchName(branchName);
  return runResult(['checkout', '-b', branchName], dirPath);
}

export async function stash(dirPath: string): Promise<GitOpResult> {
  return runResult(['stash'], dirPath);
}

export async function stashPop(dirPath: string): Promise<GitOpResult> {
  return runResult(['stash', 'pop'], dirPath);
}
