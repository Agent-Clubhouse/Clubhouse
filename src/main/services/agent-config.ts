import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DurableAgentConfig, ProjectSettings, WorktreeStatus, DeleteResult, GitStatusFile, GitLogEntry } from '../../shared/types';

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function clubhouseDir(projectPath: string): string {
  return path.join(projectPath, '.clubhouse');
}

function agentsConfigPath(projectPath: string): string {
  return path.join(clubhouseDir(projectPath), 'agents.json');
}

function settingsPath(projectPath: string): string {
  return path.join(clubhouseDir(projectPath), 'settings.json');
}

function ensureGitignore(projectPath: string): void {
  const gitignorePath = path.join(projectPath, '.gitignore');
  const entry = '.clubhouse/';
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, 'utf-8');
    if (!content.includes(entry)) {
      fs.appendFileSync(gitignorePath, `\n# Clubhouse agent manager\n${entry}\n`);
    }
  } else {
    fs.writeFileSync(gitignorePath, `# Clubhouse agent manager\n${entry}\n`);
  }
}

function readAgents(projectPath: string): DurableAgentConfig[] {
  const configPath = agentsConfigPath(projectPath);
  if (!fs.existsSync(configPath)) return [];
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return [];
  }
}

function writeAgents(projectPath: string, agents: DurableAgentConfig[]): void {
  ensureDir(clubhouseDir(projectPath));
  fs.writeFileSync(agentsConfigPath(projectPath), JSON.stringify(agents, null, 2), 'utf-8');
}

export function listDurable(projectPath: string): DurableAgentConfig[] {
  return readAgents(projectPath);
}

export function createDurable(
  projectPath: string,
  name: string,
  color: string,
  localOnly: boolean,
  model?: string,
): DurableAgentConfig {
  ensureDir(clubhouseDir(projectPath));
  ensureGitignore(projectPath);

  const id = `durable_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const branch = `${name}/standby`;
  const agentSubdir = localOnly ? '.local' : 'agents';
  const worktreePath = path.join(clubhouseDir(projectPath), agentSubdir, name);

  // Create the branch (from current HEAD)
  const hasGit = fs.existsSync(path.join(projectPath, '.git'));
  if (hasGit) {
    try {
      // Create the branch
      execSync(`git branch "${branch}"`, { cwd: projectPath, encoding: 'utf-8' });
    } catch {
      // Branch may already exist
    }

    try {
      // Create worktree
      ensureDir(path.dirname(worktreePath));
      execSync(`git worktree add "${worktreePath}" "${branch}"`, {
        cwd: projectPath,
        encoding: 'utf-8',
      });
    } catch {
      // Worktree may already exist, or git worktree not supported
      // Fallback: just create the directory
      ensureDir(worktreePath);
    }
  } else {
    ensureDir(worktreePath);
  }

  // Copy default CLAUDE.md if configured
  const settings = getSettings(projectPath);
  if (settings.defaultClaudeMd) {
    const claudeMdPath = path.join(worktreePath, 'CLAUDE.md');
    if (!fs.existsSync(claudeMdPath)) {
      fs.writeFileSync(claudeMdPath, settings.defaultClaudeMd, 'utf-8');
    }
  }

  const config: DurableAgentConfig = {
    id,
    name,
    color,
    localOnly,
    branch,
    worktreePath,
    createdAt: new Date().toISOString(),
    ...(model && model !== 'default' ? { model } : {}),
  };

  const agents = readAgents(projectPath);
  agents.push(config);
  writeAgents(projectPath, agents);

  return config;
}

export function renameDurable(projectPath: string, agentId: string, newName: string): void {
  const agents = readAgents(projectPath);
  const agent = agents.find((a) => a.id === agentId);
  if (!agent) return;
  agent.name = newName;
  writeAgents(projectPath, agents);
}

export function deleteDurable(projectPath: string, agentId: string): void {
  const agents = readAgents(projectPath);
  const agent = agents.find((a) => a.id === agentId);
  if (!agent) return;

  // Remove worktree
  const hasGit = fs.existsSync(path.join(projectPath, '.git'));
  if (hasGit) {
    try {
      execSync(`git worktree remove "${agent.worktreePath}" --force`, {
        cwd: projectPath,
        encoding: 'utf-8',
      });
    } catch {
      // Manual cleanup
    }

    // Optionally delete branch
    try {
      execSync(`git branch -D "${agent.branch}"`, {
        cwd: projectPath,
        encoding: 'utf-8',
      });
    } catch {
      // Branch may not exist
    }
  }

  // Remove directory if still exists
  if (fs.existsSync(agent.worktreePath)) {
    fs.rmSync(agent.worktreePath, { recursive: true, force: true });
  }

  const filtered = agents.filter((a) => a.id !== agentId);
  writeAgents(projectPath, filtered);
}

export function getSettings(projectPath: string): ProjectSettings {
  const p = settingsPath(projectPath);
  if (!fs.existsSync(p)) {
    return { defaultClaudeMd: '', quickAgentClaudeMd: '' };
  }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return { defaultClaudeMd: '', quickAgentClaudeMd: '' };
  }
}

export function saveSettings(projectPath: string, settings: ProjectSettings): void {
  ensureDir(clubhouseDir(projectPath));
  fs.writeFileSync(settingsPath(projectPath), JSON.stringify(settings, null, 2), 'utf-8');
}

function detectBaseBranch(projectPath: string): string {
  // Try main, then master, then fallback to HEAD
  for (const candidate of ['main', 'master']) {
    try {
      execSync(`git rev-parse --verify ${candidate}`, { cwd: projectPath, encoding: 'utf-8', stdio: 'pipe' });
      return candidate;
    } catch {
      // not found
    }
  }
  return 'HEAD';
}

function parseStatusLine(line: string): GitStatusFile {
  const xy = line.substring(0, 2);
  const filePath = line.substring(3);
  const staged = xy[0] !== ' ' && xy[0] !== '?';
  return { path: filePath, status: xy.trim(), staged };
}

function parseLogLine(line: string): GitLogEntry | null {
  // format: hash|shortHash|subject|author|date
  const parts = line.split('|');
  if (parts.length < 5) return null;
  return {
    hash: parts[0],
    shortHash: parts[1],
    subject: parts.slice(2, -2).join('|'), // subject may contain |
    author: parts[parts.length - 2],
    date: parts[parts.length - 1],
  };
}

export function getWorktreeStatus(projectPath: string, agentId: string): WorktreeStatus {
  const agents = readAgents(projectPath);
  const agent = agents.find((a) => a.id === agentId);
  if (!agent) {
    return { isValid: false, branch: '', uncommittedFiles: [], unpushedCommits: [], hasRemote: false };
  }

  const wt = agent.worktreePath;
  if (!fs.existsSync(wt) || !fs.existsSync(path.join(wt, '.git'))) {
    return { isValid: false, branch: agent.branch, uncommittedFiles: [], unpushedCommits: [], hasRemote: false };
  }

  // Get uncommitted files
  let uncommittedFiles: GitStatusFile[] = [];
  try {
    const statusOut = execSync('git status --porcelain', { cwd: wt, encoding: 'utf-8', stdio: 'pipe' });
    uncommittedFiles = statusOut.trim().split('\n').filter(Boolean).map(parseStatusLine);
  } catch {
    // ignore
  }

  // Detect base branch and get unpushed commits
  const base = detectBaseBranch(projectPath);
  let unpushedCommits: GitLogEntry[] = [];
  try {
    const logOut = execSync(
      `git log ${base}..HEAD --format="%H|%h|%s|%an|%ai"`,
      { cwd: wt, encoding: 'utf-8', stdio: 'pipe' }
    );
    unpushedCommits = logOut.trim().split('\n').filter(Boolean)
      .map(parseLogLine)
      .filter((e): e is GitLogEntry => e !== null);
  } catch {
    // ignore
  }

  // Check if remote exists
  let hasRemote = false;
  try {
    const remoteOut = execSync('git remote', { cwd: wt, encoding: 'utf-8', stdio: 'pipe' });
    hasRemote = remoteOut.trim().length > 0;
  } catch {
    // ignore
  }

  return {
    isValid: true,
    branch: agent.branch,
    uncommittedFiles,
    unpushedCommits,
    hasRemote,
  };
}

export function deleteCommitAndPush(projectPath: string, agentId: string): DeleteResult {
  const agents = readAgents(projectPath);
  const agent = agents.find((a) => a.id === agentId);
  if (!agent) return { ok: false, message: 'Agent not found' };

  const wt = agent.worktreePath;
  try {
    // Stage all and commit
    execSync('git add -A', { cwd: wt, encoding: 'utf-8', stdio: 'pipe' });
    try {
      execSync('git commit -m "Save work before deletion"', { cwd: wt, encoding: 'utf-8', stdio: 'pipe' });
    } catch {
      // Nothing to commit is OK
    }

    // Push if remote exists
    try {
      const remoteOut = execSync('git remote', { cwd: wt, encoding: 'utf-8', stdio: 'pipe' });
      if (remoteOut.trim()) {
        execSync(`git push -u origin "${agent.branch}"`, { cwd: wt, encoding: 'utf-8', stdio: 'pipe' });
      }
    } catch {
      // Push failed — continue with deletion, work is committed locally
    }
  } catch (err: any) {
    return { ok: false, message: err.message || 'Failed to commit' };
  }

  deleteDurable(projectPath, agentId);
  return { ok: true, message: 'Committed, pushed, and deleted' };
}

export function deleteWithCleanupBranch(projectPath: string, agentId: string): DeleteResult {
  const agents = readAgents(projectPath);
  const agent = agents.find((a) => a.id === agentId);
  if (!agent) return { ok: false, message: 'Agent not found' };

  const wt = agent.worktreePath;
  const cleanupBranch = `${agent.name}/cleanup`;

  try {
    // Create and checkout cleanup branch
    try {
      execSync(`git checkout -b "${cleanupBranch}"`, { cwd: wt, encoding: 'utf-8', stdio: 'pipe' });
    } catch {
      // Branch may exist, try just checking out
      execSync(`git checkout "${cleanupBranch}"`, { cwd: wt, encoding: 'utf-8', stdio: 'pipe' });
    }

    // Stage all and commit
    execSync('git add -A', { cwd: wt, encoding: 'utf-8', stdio: 'pipe' });
    try {
      execSync('git commit -m "Cleanup: save work before agent deletion"', { cwd: wt, encoding: 'utf-8', stdio: 'pipe' });
    } catch {
      // Nothing to commit
    }

    // Push if remote exists
    try {
      const remoteOut = execSync('git remote', { cwd: wt, encoding: 'utf-8', stdio: 'pipe' });
      if (remoteOut.trim()) {
        execSync(`git push -u origin "${cleanupBranch}"`, { cwd: wt, encoding: 'utf-8', stdio: 'pipe' });
      }
    } catch {
      // Push failed — work is saved locally
    }
  } catch (err: any) {
    return { ok: false, message: err.message || 'Failed to create cleanup branch' };
  }

  deleteDurable(projectPath, agentId);
  return { ok: true, message: `Saved to ${cleanupBranch} and deleted` };
}

export function deleteSaveAsPatch(projectPath: string, agentId: string, savePath: string): DeleteResult {
  const agents = readAgents(projectPath);
  const agent = agents.find((a) => a.id === agentId);
  if (!agent) return { ok: false, message: 'Agent not found' };

  const wt = agent.worktreePath;
  const base = detectBaseBranch(projectPath);

  try {
    let patchContent = '';

    // Get diff of uncommitted changes
    try {
      const diff = execSync('git diff HEAD', { cwd: wt, encoding: 'utf-8', stdio: 'pipe', maxBuffer: 50 * 1024 * 1024 });
      if (diff.trim()) {
        patchContent += `# Uncommitted changes\n${diff}\n`;
      }
    } catch {
      // ignore
    }

    // Get untracked files diff
    try {
      const untracked = execSync('git ls-files --others --exclude-standard', { cwd: wt, encoding: 'utf-8', stdio: 'pipe' });
      if (untracked.trim()) {
        // Stage untracked so we can diff them
        execSync('git add -A', { cwd: wt, encoding: 'utf-8', stdio: 'pipe' });
        const stagedDiff = execSync('git diff --cached', { cwd: wt, encoding: 'utf-8', stdio: 'pipe', maxBuffer: 50 * 1024 * 1024 });
        if (stagedDiff.trim()) {
          patchContent += `# Staged changes (including untracked)\n${stagedDiff}\n`;
        }
        // Reset staging
        execSync('git reset HEAD', { cwd: wt, encoding: 'utf-8', stdio: 'pipe' });
      }
    } catch {
      // ignore
    }

    // Get format-patch for committed but not in base
    try {
      const patches = execSync(
        `git format-patch ${base}..HEAD --stdout`,
        { cwd: wt, encoding: 'utf-8', stdio: 'pipe', maxBuffer: 50 * 1024 * 1024 }
      );
      if (patches.trim()) {
        patchContent += `# Commits since ${base}\n${patches}\n`;
      }
    } catch {
      // ignore
    }

    if (!patchContent) {
      patchContent = '# No changes to export\n';
    }

    fs.writeFileSync(savePath, patchContent, 'utf-8');
  } catch (err: any) {
    return { ok: false, message: err.message || 'Failed to save patch' };
  }

  deleteDurable(projectPath, agentId);
  return { ok: true, message: `Patch saved to ${savePath}` };
}

export function deleteForce(projectPath: string, agentId: string): DeleteResult {
  try {
    deleteDurable(projectPath, agentId);
    return { ok: true, message: 'Force deleted' };
  } catch (err: any) {
    return { ok: false, message: err.message || 'Failed to force delete' };
  }
}

export function deleteUnregister(projectPath: string, agentId: string): DeleteResult {
  const agents = readAgents(projectPath);
  const filtered = agents.filter((a) => a.id !== agentId);
  writeAgents(projectPath, filtered);
  return { ok: true, message: 'Removed from agents list (files left on disk)' };
}
