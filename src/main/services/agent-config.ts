import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { DurableAgentConfig, OrchestratorId, QuickAgentDefaults, WorktreeStatus, DeleteResult, GitStatusFile, GitLogEntry } from '../../shared/types';
import { appLog } from './log-service';

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

const GITIGNORE_BLOCK = `# Clubhouse agent manager
.clubhouse/agents/
.clubhouse/.local/
.clubhouse/agents.json
.clubhouse/settings.local.json`;

export function ensureGitignore(projectPath: string): void {
  const gitignorePath = path.join(projectPath, '.gitignore');

  const requiredLines = [
    '.clubhouse/agents/',
    '.clubhouse/.local/',
    '.clubhouse/agents.json',
    '.clubhouse/settings.local.json',
  ];

  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, 'utf-8');

    // Check which lines are missing
    const missing = requiredLines.filter((line) => !content.includes(line));
    if (missing.length === 0) return;

    // Append only the missing lines under a header (if header isn't there yet)
    const parts: string[] = [];
    if (!content.includes('# Clubhouse agent manager')) {
      parts.push('# Clubhouse agent manager');
    }
    parts.push(...missing);

    fs.appendFileSync(gitignorePath, `\n${parts.join('\n')}\n`);
  } else {
    fs.writeFileSync(gitignorePath, `${GITIGNORE_BLOCK}\n`);
  }
}

function readAgents(projectPath: string): DurableAgentConfig[] {
  const configPath = agentsConfigPath(projectPath);
  if (!fs.existsSync(configPath)) return [];
  try {
    const agents: DurableAgentConfig[] = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return agents;
  } catch (err) {
    appLog('core:agent-config', 'error', 'Failed to parse agents.json', {
      meta: { configPath, error: err instanceof Error ? err.message : String(err) },
    });
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

export function getDurableConfig(projectPath: string, agentId: string): DurableAgentConfig | null {
  const agents = readAgents(projectPath);
  return agents.find((a) => a.id === agentId) || null;
}

export function updateDurableConfig(
  projectPath: string,
  agentId: string,
  updates: { quickAgentDefaults?: QuickAgentDefaults; orchestrator?: OrchestratorId; model?: string },
): void {
  const agents = readAgents(projectPath);
  const agent = agents.find((a) => a.id === agentId);
  if (!agent) return;
  if (updates.quickAgentDefaults !== undefined) {
    agent.quickAgentDefaults = updates.quickAgentDefaults;
  }
  if (updates.orchestrator !== undefined) {
    agent.orchestrator = updates.orchestrator;
  }
  if (updates.model !== undefined) {
    if (updates.model && updates.model !== 'default') {
      agent.model = updates.model;
    } else {
      delete agent.model;
    }
  }
  writeAgents(projectPath, agents);
}

export function createDurable(
  projectPath: string,
  name: string,
  color: string,
  model?: string,
  useWorktree: boolean = true,
  orchestrator?: OrchestratorId,
): DurableAgentConfig {
  ensureDir(clubhouseDir(projectPath));
  ensureGitignore(projectPath);

  const id = `durable_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  let branch: string | undefined;
  let worktreePath: string | undefined;

  if (useWorktree) {
    branch = `${name}/standby`;
    worktreePath = path.join(clubhouseDir(projectPath), 'agents', name);

    // Create the branch (from current HEAD)
    const hasGit = fs.existsSync(path.join(projectPath, '.git'));
    if (hasGit) {
      // Ensure repo has at least one commit (required for branching/worktrees)
      try {
        execSync('git rev-parse HEAD', { cwd: projectPath, encoding: 'utf-8', stdio: 'pipe' });
      } catch {
        // Empty repo with no commits — bootstrap with an initial commit
        // Include .gitignore which ensureGitignore() has already created/updated
        appLog('core:agent-config', 'info', 'Empty repository detected, creating initial commit for worktree support', {
          meta: { agentName: name, projectPath },
        });
        try {
          const gitignorePath = path.join(projectPath, '.gitignore');
          if (fs.existsSync(gitignorePath)) {
            execSync('git add .gitignore', { cwd: projectPath, encoding: 'utf-8', stdio: 'pipe' });
          }
          execSync('git commit --allow-empty -m "Clubhouse - Initial Commit"', {
            cwd: projectPath,
            encoding: 'utf-8',
            stdio: 'pipe',
          });
        } catch (commitErr) {
          appLog('core:agent-config', 'warn', 'Failed to create initial commit in empty repository', {
            meta: {
              agentName: name,
              projectPath,
              error: commitErr instanceof Error ? commitErr.message : String(commitErr),
            },
          });
        }
      }

      try {
        execSync(`git branch "${branch}"`, { cwd: projectPath, encoding: 'utf-8' });
      } catch {
        // Branch may already exist
      }

      try {
        ensureDir(path.dirname(worktreePath));
        execSync(`git worktree add "${worktreePath}" "${branch}"`, {
          cwd: projectPath,
          encoding: 'utf-8',
        });
      } catch (err) {
        appLog('core:agent-config', 'warn', 'Git worktree creation failed, falling back to plain directory', {
          meta: {
            agentName: name,
            branch,
            worktreePath,
            error: err instanceof Error ? err.message : String(err),
          },
        });
        ensureDir(worktreePath);
      }
    } else {
      ensureDir(worktreePath);
    }
  }

  const config: DurableAgentConfig = {
    id,
    name,
    color,
    ...(branch ? { branch } : {}),
    ...(worktreePath ? { worktreePath } : {}),
    createdAt: new Date().toISOString(),
    ...(model && model !== 'default' ? { model } : {}),
    ...(orchestrator ? { orchestrator } : {}),
  };

  const agents = readAgents(projectPath);
  agents.push(config);
  writeAgents(projectPath, agents);

  return config;
}

export function reorderDurable(projectPath: string, orderedIds: string[]): DurableAgentConfig[] {
  const agents = readAgents(projectPath);
  const byId = new Map(agents.map((a) => [a.id, a]));
  const result: DurableAgentConfig[] = [];
  for (const id of orderedIds) {
    const agent = byId.get(id);
    if (agent) {
      result.push(agent);
      byId.delete(id);
    }
  }
  // Append any agents not in orderedIds (shouldn't happen, but safe)
  for (const agent of byId.values()) {
    result.push(agent);
  }
  writeAgents(projectPath, result);
  return result;
}

export function renameDurable(projectPath: string, agentId: string, newName: string): void {
  const agents = readAgents(projectPath);
  const agent = agents.find((a) => a.id === agentId);
  if (!agent) return;
  agent.name = newName;
  writeAgents(projectPath, agents);
}

export function updateDurable(
  projectPath: string,
  agentId: string,
  updates: { name?: string; color?: string; icon?: string | null },
): void {
  const agents = readAgents(projectPath);
  const agent = agents.find((a) => a.id === agentId);
  if (!agent) return;
  if (updates.name !== undefined) agent.name = updates.name;
  if (updates.color !== undefined) agent.color = updates.color;
  if (updates.icon !== undefined) {
    if (updates.icon === null || updates.icon === '') {
      delete agent.icon;
    } else {
      agent.icon = updates.icon;
    }
  }
  writeAgents(projectPath, agents);
}

export function deleteDurable(projectPath: string, agentId: string): void {
  const agents = readAgents(projectPath);
  const agent = agents.find((a) => a.id === agentId);
  if (!agent) return;

  // If no worktree, just unregister
  if (!agent.worktreePath) {
    const filtered = agents.filter((a) => a.id !== agentId);
    writeAgents(projectPath, filtered);
    return;
  }

  // Remove worktree
  const hasGit = fs.existsSync(path.join(projectPath, '.git'));
  if (hasGit) {
    try {
      execSync(`git worktree remove "${agent.worktreePath}" --force`, {
        cwd: projectPath,
        encoding: 'utf-8',
      });
    } catch (err) {
      appLog('core:agent-config', 'warn', 'Git worktree removal failed, will clean up manually', {
        meta: {
          agentId, worktreePath: agent.worktreePath,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }

    // Optionally delete branch
    if (agent.branch) {
      try {
        execSync(`git branch -D "${agent.branch}"`, {
          cwd: projectPath,
          encoding: 'utf-8',
        });
      } catch (err) {
        appLog('core:agent-config', 'warn', 'Git branch deletion failed', {
          meta: { agentId, branch: agent.branch, error: err instanceof Error ? err.message : String(err) },
        });
      }
    }
  }

  // Remove directory if still exists
  if (fs.existsSync(agent.worktreePath)) {
    fs.rmSync(agent.worktreePath, { recursive: true, force: true });
  }

  const filtered = agents.filter((a) => a.id !== agentId);
  writeAgents(projectPath, filtered);
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

  // Non-worktree agents have no worktree to inspect
  if (!agent.worktreePath) {
    return { isValid: false, branch: '', uncommittedFiles: [], unpushedCommits: [], hasRemote: false };
  }

  const wt = agent.worktreePath;
  if (!fs.existsSync(wt) || !fs.existsSync(path.join(wt, '.git'))) {
    return { isValid: false, branch: agent.branch || '', uncommittedFiles: [], unpushedCommits: [], hasRemote: false };
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
    branch: agent.branch || '',
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
  if (!wt) {
    deleteDurable(projectPath, agentId);
    return { ok: true, message: 'Deleted (no worktree)' };
  }

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
      if (remoteOut.trim() && agent.branch) {
        execSync(`git push -u origin "${agent.branch}"`, { cwd: wt, encoding: 'utf-8', stdio: 'pipe' });
      }
    } catch (pushErr) {
      appLog('core:agent-config', 'warn', 'Push failed during delete-commit-push, work saved locally', {
        meta: { agentId, branch: agent.branch, error: pushErr instanceof Error ? pushErr.message : String(pushErr) },
      });
    }
  } catch (err: any) {
    appLog('core:agent-config', 'error', 'Failed to commit during agent deletion', {
      meta: { agentId, error: err.message },
    });
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
  if (!wt) {
    deleteDurable(projectPath, agentId);
    return { ok: true, message: 'Deleted (no worktree)' };
  }

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
    } catch (pushErr) {
      appLog('core:agent-config', 'warn', 'Push failed during cleanup-branch deletion, work saved locally', {
        meta: { agentId, cleanupBranch, error: pushErr instanceof Error ? pushErr.message : String(pushErr) },
      });
    }
  } catch (err: any) {
    appLog('core:agent-config', 'error', 'Failed to create cleanup branch during agent deletion', {
      meta: { agentId, error: err.message },
    });
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
  if (!wt) {
    deleteDurable(projectPath, agentId);
    return { ok: true, message: 'Deleted (no worktree)' };
  }

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
    appLog('core:agent-config', 'error', 'Failed to save patch file during agent deletion', {
      meta: { agentId, savePath, error: err.message },
    });
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

// --- Agent icon storage ---

function getAgentIconsDir(): string {
  const dirName = app.isPackaged ? '.clubhouse' : '.clubhouse-dev';
  const dir = path.join(app.getPath('home'), dirName, 'agent-icons');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/** Save a cropped PNG data URL as the agent's icon. Returns the filename. */
export function saveAgentIcon(projectPath: string, agentId: string, dataUrl: string): string {
  removeAgentIconFile(agentId);

  const filename = `${agentId}.png`;
  const dest = path.join(getAgentIconsDir(), filename);

  // Strip data URL prefix and write binary
  const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
  fs.writeFileSync(dest, Buffer.from(base64, 'base64'));

  // Update agents.json
  const agents = readAgents(projectPath);
  const agent = agents.find((a) => a.id === agentId);
  if (agent) {
    agent.icon = filename;
    writeAgents(projectPath, agents);
  }

  return filename;
}

/** Read an agent icon file and return a data URL, or null if not found. */
export function readAgentIconData(filename: string): string | null {
  const filePath = path.join(getAgentIconsDir(), filename);
  if (!fs.existsSync(filePath)) return null;
  const data = fs.readFileSync(filePath);
  return `data:image/png;base64,${data.toString('base64')}`;
}

/** Remove the icon file for an agent. */
export function removeAgentIconFile(agentId: string): void {
  const iconsDir = getAgentIconsDir();
  try {
    const files = fs.readdirSync(iconsDir);
    for (const file of files) {
      if (file.startsWith(agentId + '.')) {
        fs.unlinkSync(path.join(iconsDir, file));
      }
    }
  } catch {
    // icons dir may not exist yet
  }
}

/** Remove agent icon metadata and file. */
export function removeAgentIcon(projectPath: string, agentId: string): void {
  removeAgentIconFile(agentId);
  const agents = readAgents(projectPath);
  const agent = agents.find((a) => a.id === agentId);
  if (agent) {
    delete agent.icon;
    writeAgents(projectPath, agents);
  }
}
