import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DurableAgentConfig, QuickAgentDefaults, ProjectSettings, WorktreeStatus, DeleteResult, GitStatusFile, GitLogEntry, ConfigLayer, ConfigItemKey } from '../../shared/types';
import { AgentContext } from '../../shared/template-engine';
import { resolveProjectDefaults, resolveDurableConfig, diffConfigLayers, defaultOverrideFlags } from './config-resolver';
import { materializeAll, repairMissing, materializeClaudeMd, materializePermissions } from './config-materializer';

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

function localSettingsPath(projectPath: string): string {
  return path.join(clubhouseDir(projectPath), 'settings.local.json');
}

function buildAgentContext(config: DurableAgentConfig, projectPath: string): AgentContext {
  return {
    agentName: config.name,
    agentType: 'durable',
    worktreePath: config.worktreePath,
    branch: config.branch,
    projectPath,
    role: config.role,
  };
}

const GITIGNORE_BLOCK = `# Clubhouse agent manager
.clubhouse/agents/
.clubhouse/.local/
.clubhouse/agents.json
.clubhouse/settings.local.json`;

function ensureGitignore(projectPath: string): void {
  const gitignorePath = path.join(projectPath, '.gitignore');

  if (fs.existsSync(gitignorePath)) {
    let content = fs.readFileSync(gitignorePath, 'utf-8');

    // Migrate old blanket pattern to selective patterns
    const oldPatternRe = /# Clubhouse agent manager\n\.clubhouse\/\n?/;
    if (oldPatternRe.test(content)) {
      content = content.replace(oldPatternRe, GITIGNORE_BLOCK + '\n');
      fs.writeFileSync(gitignorePath, content, 'utf-8');
      return;
    }

    // Already has selective patterns
    if (content.includes('.clubhouse/agents/')) {
      return;
    }

    // Append new block
    fs.appendFileSync(gitignorePath, `\n${GITIGNORE_BLOCK}\n`);
  } else {
    fs.writeFileSync(gitignorePath, `${GITIGNORE_BLOCK}\n`);
  }
}

function readAgents(projectPath: string): DurableAgentConfig[] {
  const configPath = agentsConfigPath(projectPath);
  if (!fs.existsSync(configPath)) return [];
  try {
    const agents: DurableAgentConfig[] = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    let needsWrite = false;

    // Migrate agents that lack override fields
    for (const agent of agents) {
      if (!agent.overrides) {
        agent.overrides = defaultOverrideFlags();
        agent.quickOverrides = defaultOverrideFlags();
        agent.quickConfigLayer = {};

        // Auto-detect if agent's CLAUDE.md differs from project default
        // to avoid overwriting customized content on first sync
        try {
          const defaults = resolveProjectDefaults(projectPath);
          const claudeMdPath = path.join(agent.worktreePath, 'CLAUDE.md');
          if (fs.existsSync(claudeMdPath)) {
            const currentContent = fs.readFileSync(claudeMdPath, 'utf-8');
            if (defaults.claudeMd && currentContent !== defaults.claudeMd) {
              agent.overrides.claudeMd = true;
            }
          }
        } catch {
          // Ignore — safe default is all false
        }

        needsWrite = true;
      }
    }

    if (needsWrite) {
      writeAgents(projectPath, agents);
    }

    return agents;
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

export function getDurableConfig(projectPath: string, agentId: string): DurableAgentConfig | null {
  const agents = readAgents(projectPath);
  return agents.find((a) => a.id === agentId) || null;
}

export function updateDurableConfig(
  projectPath: string,
  agentId: string,
  updates: { quickAgentDefaults?: QuickAgentDefaults },
): void {
  const agents = readAgents(projectPath);
  const agent = agents.find((a) => a.id === agentId);
  if (!agent) return;
  if (updates.quickAgentDefaults !== undefined) {
    agent.quickAgentDefaults = updates.quickAgentDefaults;
  }
  writeAgents(projectPath, agents);
}

export function createDurable(
  projectPath: string,
  name: string,
  color: string,
  model?: string,
  role?: 'host',
): DurableAgentConfig {
  ensureDir(clubhouseDir(projectPath));
  ensureGitignore(projectPath);

  const id = `durable_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const branch = `${name}/standby`;
  const worktreePath = path.join(clubhouseDir(projectPath), 'agents', name);

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

  const overrides = defaultOverrideFlags();

  const config: DurableAgentConfig = {
    id,
    name,
    color,
    ...(role ? { role } : {}),
    branch,
    worktreePath,
    createdAt: new Date().toISOString(),
    ...(model && model !== 'default' ? { model } : {}),
    overrides,
    quickOverrides: defaultOverrideFlags(),
    quickConfigLayer: {},
  };

  // Materialize all config from project defaults (with template expansion)
  const resolved = resolveProjectDefaults(projectPath);
  const agentContext = buildAgentContext(config, projectPath);
  materializeAll(worktreePath, resolved, overrides, projectPath, agentContext);

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

export function updateDurable(
  projectPath: string,
  agentId: string,
  updates: { name?: string; color?: string; emoji?: string | null },
): void {
  const agents = readAgents(projectPath);
  const agent = agents.find((a) => a.id === agentId);
  if (!agent) return;
  if (updates.name !== undefined) agent.name = updates.name;
  if (updates.color !== undefined) agent.color = updates.color;
  if (updates.emoji !== undefined) {
    if (updates.emoji === null || updates.emoji === '') {
      delete agent.emoji;
    } else {
      agent.emoji = updates.emoji;
    }
  }
  writeAgents(projectPath, agents);
}

export function deleteDurable(projectPath: string, agentId: string): void {
  const agents = readAgents(projectPath);
  const agent = agents.find((a) => a.id === agentId);
  if (!agent) return;

  if (agent.role === 'host') {
    throw new Error('Cannot delete the project host agent');
  }

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
    return { defaults: {}, quickOverrides: {} };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));

    // Migrate old format { defaultClaudeMd, quickAgentClaudeMd } → new format
    if (raw.defaultClaudeMd !== undefined && !raw.defaults) {
      const migrated: ProjectSettings = {
        defaults: { claudeMd: raw.defaultClaudeMd || undefined },
        quickOverrides: { claudeMd: raw.quickAgentClaudeMd || undefined },
      };
      // Write back immediately so migration happens once
      fs.writeFileSync(p, JSON.stringify(migrated, null, 2), 'utf-8');
      return migrated;
    }

    // Ensure defaults and quickOverrides exist
    if (!raw.defaults) raw.defaults = {};
    if (!raw.quickOverrides) raw.quickOverrides = {};

    return raw;
  } catch {
    return { defaults: {}, quickOverrides: {} };
  }
}

export function saveSettings(projectPath: string, settings: ProjectSettings): void {
  ensureDir(clubhouseDir(projectPath));

  // Compute diff to know what changed
  const oldSettings = getSettings(projectPath);
  const oldDefaults = resolveProjectDefaults(projectPath);

  fs.writeFileSync(settingsPath(projectPath), JSON.stringify(settings, null, 2), 'utf-8');

  // Sync agents with changed defaults
  const newDefaults = resolveProjectDefaults(projectPath);
  const changedKeys = diffConfigLayers(oldDefaults, newDefaults);
  if (changedKeys.length > 0) {
    syncAllAgents(projectPath, changedKeys);
  }
}

export function getLocalSettings(projectPath: string): ConfigLayer {
  const p = localSettingsPath(projectPath);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return {};
  }
}

export function saveLocalSettings(projectPath: string, localConfig: ConfigLayer): void {
  ensureDir(clubhouseDir(projectPath));

  const oldDefaults = resolveProjectDefaults(projectPath);
  fs.writeFileSync(localSettingsPath(projectPath), JSON.stringify(localConfig, null, 2), 'utf-8');

  const newDefaults = resolveProjectDefaults(projectPath);
  const changedKeys = diffConfigLayers(oldDefaults, newDefaults);
  if (changedKeys.length > 0) {
    syncAllAgents(projectPath, changedKeys);
  }
}

/**
 * Iterate all agents, re-materialize non-overridden items for changed keys.
 */
export function syncAllAgents(projectPath: string, changedKeys?: ConfigItemKey[]): void {
  const agents = readAgents(projectPath);
  const defaults = resolveProjectDefaults(projectPath);

  for (const agent of agents) {
    if (agent.role === 'host') continue; // Host manages its own config
    if (!fs.existsSync(agent.worktreePath)) continue;
    const overrides = agent.overrides || defaultOverrideFlags();

    // Build a resolved layer with only the changed (and non-overridden) items
    const toApply: ConfigLayer = {};
    const keysToCheck = changedKeys || (['claudeMd', 'permissions', 'mcpConfig'] as ConfigItemKey[]);

    for (const key of keysToCheck) {
      if (!overrides[key] && key in defaults) {
        (toApply as Record<string, unknown>)[key] = (defaults as Record<string, unknown>)[key];
      }
    }

    const agentContext = buildAgentContext(agent, projectPath);
    materializeAll(agent.worktreePath, toApply, overrides, projectPath, agentContext);
  }
}

/**
 * Toggle an override flag for an agent.
 * If disabling: re-materialize from defaults.
 * If enabling for dirs: current content stays (snapshot).
 */
export function toggleOverride(
  projectPath: string,
  agentId: string,
  key: ConfigItemKey,
  enable: boolean,
): DurableAgentConfig | null {
  const agents = readAgents(projectPath);
  const agent = agents.find((a) => a.id === agentId);
  if (!agent) return null;

  if (!agent.overrides) agent.overrides = defaultOverrideFlags();
  agent.overrides[key] = enable;

  writeAgents(projectPath, agents);

  // If disabling override (reverting to synced), re-materialize from defaults
  if (!enable && fs.existsSync(agent.worktreePath)) {
    const defaults = resolveProjectDefaults(projectPath);
    const resolved: ConfigLayer = {};

    if (key === 'claudeMd' || key === 'permissions' || key === 'mcpConfig') {
      (resolved as Record<string, unknown>)[key] = (defaults as Record<string, unknown>)[key];
    }

    const agentContext = buildAgentContext(agent, projectPath);
    materializeAll(agent.worktreePath, resolved, agent.overrides, projectPath, agentContext);
  }

  return agent;
}

/**
 * Prepare an agent for spawn: repair missing config + write hooks.
 */
export function prepareSpawn(projectPath: string, agentId: string): void {
  const agents = readAgents(projectPath);
  const agent = agents.find((a) => a.id === agentId);
  if (!agent) return;

  const resolved = resolveDurableConfig(projectPath, agentId);
  const overrides = agent.overrides || defaultOverrideFlags();
  const agentContext = buildAgentContext(agent, projectPath);
  repairMissing(agent.worktreePath, resolved, overrides, projectPath, agentContext);
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

  // Host agents run at project root — not a meaningful worktree to diff
  if (agent.role === 'host') {
    return { isValid: true, branch: '', uncommittedFiles: [], unpushedCommits: [], hasRemote: false };
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
  if (agent.role === 'host') return { ok: false, message: 'Cannot delete the project host agent' };

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
  if (agent.role === 'host') return { ok: false, message: 'Cannot delete the project host agent' };

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
  if (agent.role === 'host') return { ok: false, message: 'Cannot delete the project host agent' };

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
  const agents = readAgents(projectPath);
  const agent = agents.find((a) => a.id === agentId);
  if (agent?.role === 'host') return { ok: false, message: 'Cannot delete the project host agent' };

  try {
    deleteDurable(projectPath, agentId);
    return { ok: true, message: 'Force deleted' };
  } catch (err: any) {
    return { ok: false, message: err.message || 'Failed to force delete' };
  }
}

export function deleteUnregister(projectPath: string, agentId: string): DeleteResult {
  const agents = readAgents(projectPath);
  const agent = agents.find((a) => a.id === agentId);
  if (agent?.role === 'host') return { ok: false, message: 'Cannot delete the project host agent' };

  const filtered = agents.filter((a) => a.id !== agentId);
  writeAgents(projectPath, filtered);
  return { ok: true, message: 'Removed from agents list (files left on disk)' };
}

const CLUBHOUSE_README = `# .clubhouse/

This directory is managed by [Clubhouse](https://github.com/Clubhouse) — a multi-agent manager for Claude Code.

## Directory Structure

### Tracked (committed to git)
- \`settings.json\` — Project-level defaults for all agents (CLAUDE.md template, permissions, MCP config)
- \`skills/\` — Shared Claude Code skills available to all agents
- \`notes/\` — Project notes accessible to agents
- \`README.md\` — This file

### Gitignored (machine-local)
- \`agents/\` — Git worktrees for each durable agent
- \`.local/\` — Legacy local-only agent worktrees
- \`agents.json\` — Agent registry (IDs, names, branches, overrides)
- \`settings.local.json\` — Personal overrides layered on top of settings.json

## How Settings Work

### settings.json (shared)
Team-wide defaults. All agents inherit from this unless they override a specific item.

\`\`\`json
{
  "defaults": {
    "claudeMd": "# Instructions for all agents...",
    "permissions": { "allow": ["Bash(git:*)", "Bash(npm:*)"] }
  },
  "quickOverrides": {
    "claudeMd": "# Quick agent specific instructions..."
  }
}
\`\`\`

### settings.local.json (personal)
Your personal overrides. Merged on top of settings.json. Not committed.

### Per-agent overrides
Each agent can override specific config items (CLAUDE.md, permissions, MCP).
When an override is enabled, the agent manages that item locally instead of inheriting from defaults.

## Template Variables

CLAUDE.md templates support these variables:
- \`{{AGENT_NAME}}\` — The agent's name
- \`{{AGENT_TYPE}}\` — \`durable\` or \`quick\`
- \`{{WORKTREE_PATH}}\` — Absolute path to the agent's worktree
- \`{{BRANCH}}\` — The agent's standby branch
- \`{{PROJECT_PATH}}\` — Absolute path to the project root

## Agent Lifecycle

1. **Create** — A worktree + branch are created, config is materialized from defaults
2. **Materialize** — CLAUDE.md, permissions, MCP config, skills are written to the worktree
3. **Wake** — Missing config is repaired, hooks are set up, Claude Code is launched
4. **Work** — The agent works in its worktree on a feature branch
5. **Sleep** — Claude Code exits, the agent returns to sleeping state
`;

function ensureClubhouseReadme(projectPath: string): void {
  const readmePath = path.join(clubhouseDir(projectPath), 'README.md');
  if (fs.existsSync(readmePath)) return;
  ensureDir(clubhouseDir(projectPath));
  fs.writeFileSync(readmePath, CLUBHOUSE_README, 'utf-8');
}

/**
 * Idempotent: ensure a project host agent exists. Creates one if none found.
 * Also ensures gitignore and README are up-to-date.
 */
export function ensureHostAgent(projectPath: string): DurableAgentConfig {
  ensureGitignore(projectPath);
  ensureClubhouseReadme(projectPath);

  const agents = readAgents(projectPath);
  const existing = agents.find((a) => a.role === 'host');
  if (existing) return existing;

  return createDurable(projectPath, 'project-host', 'amber', undefined, 'host');
}
