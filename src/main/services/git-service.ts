import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { GitInfo, GitStatusFile, GitLogEntry, GitOpResult } from '../../shared/types';

// Conflict status codes from git porcelain format
const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

function run(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: 'utf-8', timeout: 10000 }).trim();
  } catch {
    return '';
  }
}

function runResult(cmd: string, cwd: string): GitOpResult {
  try {
    const output = execSync(cmd, { cwd, encoding: 'utf-8', timeout: 30000 }).trim();
    return { ok: true, message: output };
  } catch (err: any) {
    const msg = err?.stderr?.toString?.() || err?.message || 'Unknown error';
    return { ok: false, message: msg.trim() };
  }
}

export function getGitInfo(dirPath: string): GitInfo {
  const hasGit = fs.existsSync(path.join(dirPath, '.git'));
  if (!hasGit) {
    return { branch: '', branches: [], status: [], log: [], hasGit: false, ahead: 0, behind: 0, remote: '', stashCount: 0, hasConflicts: false };
  }

  const branch = run('git rev-parse --abbrev-ref HEAD', dirPath) || 'HEAD';

  const branchesRaw = run('git branch --no-color', dirPath);
  const branches = branchesRaw
    .split('\n')
    .map((b) => b.replace(/^\*?\s+/, '').trim())
    .filter(Boolean);

  const statusRaw = run('git status --porcelain -uall', dirPath);
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

  const logRaw = run(
    'git log --oneline --format="%H|||%h|||%s|||%an|||%ar" -20',
    dirPath
  );
  const log: GitLogEntry[] = logRaw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, shortHash, subject, author, date] = line.split('|||');
      return { hash, shortHash, subject, author, date };
    });

  // Remote tracking info
  const remote = run('git remote', dirPath).split('\n')[0] || '';
  let ahead = 0;
  let behind = 0;
  if (remote) {
    const abRaw = run(`git rev-list --left-right --count ${remote}/${branch}...HEAD`, dirPath);
    if (abRaw) {
      const parts = abRaw.split(/\s+/);
      behind = parseInt(parts[0], 10) || 0;
      ahead = parseInt(parts[1], 10) || 0;
    }
  }

  // Stash count
  const stashRaw = run('git stash list', dirPath);
  const stashCount = stashRaw ? stashRaw.split('\n').filter(Boolean).length : 0;

  return { branch, branches, status, log, hasGit, ahead, behind, remote, stashCount, hasConflicts };
}

export function checkout(dirPath: string, branchName: string): boolean {
  try {
    execSync(`git checkout ${branchName}`, { cwd: dirPath, encoding: 'utf-8' });
    return true;
  } catch {
    return false;
  }
}

export function stage(dirPath: string, filePath: string): boolean {
  try {
    execSync(`git add -- "${filePath}"`, { cwd: dirPath, encoding: 'utf-8' });
    return true;
  } catch {
    return false;
  }
}

export function unstage(dirPath: string, filePath: string): boolean {
  try {
    execSync(`git reset HEAD -- "${filePath}"`, { cwd: dirPath, encoding: 'utf-8' });
    return true;
  } catch {
    return false;
  }
}

export function commit(dirPath: string, message: string): GitOpResult {
  return runResult(`git commit -m "${message.replace(/"/g, '\\"')}"`, dirPath);
}

export function push(dirPath: string): GitOpResult {
  const info = getGitInfo(dirPath);
  if (!info.remote) {
    return { ok: false, message: 'No remote configured' };
  }
  return runResult(`git push ${info.remote} ${info.branch}`, dirPath);
}

export function getFileDiff(
  dirPath: string,
  filePath: string,
  staged: boolean
): { original: string; modified: string } {
  // Get the HEAD version (empty for new/untracked files)
  let original = '';
  try {
    original = execSync(`git show HEAD:"${filePath}"`, {
      cwd: dirPath,
      encoding: 'utf-8',
      timeout: 10000,
    });
  } catch {
    // File doesn't exist in HEAD (new/untracked) — leave empty
  }

  let modified = '';
  if (staged) {
    // Staged version from the index
    try {
      modified = execSync(`git show :"${filePath}"`, {
        cwd: dirPath,
        encoding: 'utf-8',
        timeout: 10000,
      });
    } catch {
      modified = '';
    }
  } else {
    // Working tree version from disk
    try {
      modified = fs.readFileSync(path.join(dirPath, filePath), 'utf-8');
    } catch {
      modified = '';
    }
  }

  return { original, modified };
}

export function pull(dirPath: string): GitOpResult {
  const info = getGitInfo(dirPath);
  if (!info.remote) {
    return { ok: false, message: 'No remote configured' };
  }
  return runResult(`git pull ${info.remote} ${info.branch}`, dirPath);
}

export function stageAll(dirPath: string): boolean {
  try {
    execSync('git add -A', { cwd: dirPath, encoding: 'utf-8' });
    return true;
  } catch {
    return false;
  }
}

export function unstageAll(dirPath: string): boolean {
  try {
    execSync('git reset HEAD', { cwd: dirPath, encoding: 'utf-8' });
    return true;
  } catch {
    return false;
  }
}

export function discardFile(dirPath: string, filePath: string, isUntracked: boolean): GitOpResult {
  if (isUntracked) {
    // Remove untracked file from disk
    try {
      fs.unlinkSync(path.join(dirPath, filePath));
      return { ok: true, message: 'Deleted untracked file' };
    } catch (err: any) {
      return { ok: false, message: err?.message || 'Failed to delete file' };
    }
  }
  return runResult(`git restore -- "${filePath}"`, dirPath);
}

export function createBranch(dirPath: string, branchName: string): GitOpResult {
  return runResult(`git checkout -b "${branchName}"`, dirPath);
}

export function stash(dirPath: string): GitOpResult {
  return runResult('git stash', dirPath);
}

export function stashPop(dirPath: string): GitOpResult {
  return runResult('git stash pop', dirPath);
}
