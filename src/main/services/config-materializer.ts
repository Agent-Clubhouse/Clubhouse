import * as fs from 'fs';
import * as path from 'path';
import { ConfigLayer, OverrideFlags, PermissionsConfig, McpConfig } from '../../shared/types';
import { resolveProjectDefaults, resolveDurableConfig } from './config-resolver';

/**
 * Write or delete CLAUDE.md in a worktree.
 */
export function materializeClaudeMd(worktreePath: string, content: string | null | undefined): void {
  const filePath = path.join(worktreePath, 'CLAUDE.md');
  if (content === null || content === undefined) {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    return;
  }
  fs.writeFileSync(filePath, content, 'utf-8');
}

/**
 * Read settings.local.json, set permissions key, preserve hooks key, write back.
 */
export function materializePermissions(worktreePath: string, permissions: PermissionsConfig | null | undefined): void {
  const claudeDir = path.join(worktreePath, '.claude');
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }

  const settingsPath = path.join(claudeDir, 'settings.local.json');

  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch {
    // No existing file
  }

  if (permissions === null || permissions === undefined) {
    delete existing.permissions;
  } else {
    existing.permissions = permissions;
  }

  fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2), 'utf-8');
}

/**
 * Write or delete .mcp.json in a worktree.
 */
export function materializeMcpConfig(worktreePath: string, config: McpConfig | null | undefined): void {
  const filePath = path.join(worktreePath, '.mcp.json');
  if (config === null || config === undefined) {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    return;
  }
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Clean-sync a directory: delete stale files, copy new ones from source.
 */
export function materializeDir(sourceDir: string, targetDir: string): void {
  if (!fs.existsSync(sourceDir)) return;

  // Remove existing target dir contents
  if (fs.existsSync(targetDir)) {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
  fs.mkdirSync(targetDir, { recursive: true });

  // Copy recursively
  copyDirRecursive(sourceDir, targetDir);
}

function copyDirRecursive(src: string, dest: string): void {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Orchestrate materializing all 5 config items.
 * Skips overridden ones (agent manages them locally).
 */
export function materializeAll(
  worktreePath: string,
  resolved: ConfigLayer,
  overrides: OverrideFlags,
  projectPath: string,
): void {
  // claudeMd
  if (!overrides.claudeMd && 'claudeMd' in resolved) {
    materializeClaudeMd(worktreePath, resolved.claudeMd);
  }

  // permissions
  if (!overrides.permissions && 'permissions' in resolved) {
    materializePermissions(worktreePath, resolved.permissions);
  }

  // mcpConfig
  if (!overrides.mcpConfig && 'mcpConfig' in resolved) {
    materializeMcpConfig(worktreePath, resolved.mcpConfig);
  }

  // skills
  if (!overrides.skills) {
    const settingsPath = path.join(projectPath, '.clubhouse', 'settings.json');
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      if (settings.defaultSkillsPath) {
        const sourceDir = path.join(projectPath, '.clubhouse', settings.defaultSkillsPath);
        const targetDir = path.join(worktreePath, '.claude', 'skills');
        materializeDir(sourceDir, targetDir);
      }
    } catch {
      // No settings
    }
  }

  // agents
  if (!overrides.agents) {
    const settingsPath = path.join(projectPath, '.clubhouse', 'settings.json');
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      if (settings.defaultAgentsPath) {
        const sourceDir = path.join(projectPath, '.clubhouse', settings.defaultAgentsPath);
        const targetDir = path.join(worktreePath, '.claude', 'agents');
        materializeDir(sourceDir, targetDir);
      }
    } catch {
      // No settings
    }
  }
}

/**
 * Validate non-overridden items exist, re-materialize if missing.
 * Called at spawn time.
 */
export function repairMissing(
  worktreePath: string,
  resolved: ConfigLayer,
  overrides: OverrideFlags,
  projectPath: string,
): void {
  // claudeMd
  if (!overrides.claudeMd && resolved.claudeMd !== null && resolved.claudeMd !== undefined) {
    const claudeMdPath = path.join(worktreePath, 'CLAUDE.md');
    if (!fs.existsSync(claudeMdPath)) {
      materializeClaudeMd(worktreePath, resolved.claudeMd);
    }
  }

  // permissions - always re-materialize since it merges into settings.local.json
  if (!overrides.permissions && resolved.permissions !== undefined) {
    materializePermissions(worktreePath, resolved.permissions);
  }

  // mcpConfig
  if (!overrides.mcpConfig && resolved.mcpConfig !== null && resolved.mcpConfig !== undefined) {
    const mcpPath = path.join(worktreePath, '.mcp.json');
    if (!fs.existsSync(mcpPath)) {
      materializeMcpConfig(worktreePath, resolved.mcpConfig);
    }
  }

  // skills
  if (!overrides.skills) {
    const settingsPath = path.join(projectPath, '.clubhouse', 'settings.json');
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      if (settings.defaultSkillsPath) {
        const skillsDir = path.join(worktreePath, '.claude', 'skills');
        if (!fs.existsSync(skillsDir)) {
          const sourceDir = path.join(projectPath, '.clubhouse', settings.defaultSkillsPath);
          materializeDir(sourceDir, skillsDir);
        }
      }
    } catch {
      // No settings
    }
  }

  // agents
  if (!overrides.agents) {
    const settingsPath = path.join(projectPath, '.clubhouse', 'settings.json');
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      if (settings.defaultAgentsPath) {
        const agentsDir = path.join(worktreePath, '.claude', 'agents');
        if (!fs.existsSync(agentsDir)) {
          const sourceDir = path.join(projectPath, '.clubhouse', settings.defaultAgentsPath);
          materializeDir(sourceDir, agentsDir);
        }
      }
    } catch {
      // No settings
    }
  }
}
