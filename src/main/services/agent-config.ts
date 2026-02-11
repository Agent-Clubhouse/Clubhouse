import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DurableAgentConfig, ProjectSettings } from '../../shared/types';

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
  };

  const agents = readAgents(projectPath);
  agents.push(config);
  writeAgents(projectPath, agents);

  return config;
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
