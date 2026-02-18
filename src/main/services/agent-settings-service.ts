import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { McpServerEntry, SkillEntry, AgentTemplateEntry, PermissionsConfig } from '../../shared/types';

/** Local settings shape for .clubhouse/settings.json */
interface ProjectSettings {
  defaults: Record<string, unknown>;
  quickOverrides: Record<string, unknown>;
  defaultSkillsPath?: string;
  defaultAgentsPath?: string;
}

export function readClaudeMd(worktreePath: string): string {
  const filePath = path.join(worktreePath, 'CLAUDE.md');
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

export function writeClaudeMd(worktreePath: string, content: string): void {
  const filePath = path.join(worktreePath, 'CLAUDE.md');
  fs.writeFileSync(filePath, content, 'utf-8');
}

function parseMcpServers(filePath: string, scope: 'project' | 'global'): McpServerEntry[] {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    const servers = parsed.mcpServers || {};
    return Object.entries(servers).map(([name, config]: [string, Record<string, unknown>]) => ({
      name,
      command: (config.command as string) || '',
      args: config.args as string[] | undefined,
      env: config.env as Record<string, string> | undefined,
      scope,
    }));
  } catch {
    return [];
  }
}

export function readMcpConfig(worktreePath: string): McpServerEntry[] {
  const projectServers = parseMcpServers(path.join(worktreePath, '.mcp.json'), 'project');
  const globalServers = parseMcpServers(path.join(os.homedir(), '.claude.json'), 'global');

  // Dedupe: project-scoped servers take priority over global ones with the same name
  const seen = new Set(projectServers.map((s) => s.name));
  const uniqueGlobal = globalServers.filter((s) => !seen.has(s.name));

  return [...projectServers, ...uniqueGlobal];
}

export function listSkills(worktreePath: string): SkillEntry[] {
  const skillsDir = path.join(worktreePath, '.claude', 'skills');
  try {
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => {
        const skillPath = path.join(skillsDir, e.name);
        const hasReadme = fs.existsSync(path.join(skillPath, 'README.md'));
        return { name: e.name, path: skillPath, hasReadme };
      });
  } catch {
    return [];
  }
}

export function listAgentTemplates(worktreePath: string): AgentTemplateEntry[] {
  const agentsDir = path.join(worktreePath, '.claude', 'agents');
  try {
    const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => {
        const agentPath = path.join(agentsDir, e.name);
        const hasReadme = fs.existsSync(path.join(agentPath, 'README.md'));
        return { name: e.name, path: agentPath, hasReadme };
      });
  } catch {
    return [];
  }
}

function readSettings(projectPath: string): ProjectSettings {
  const settingsFile = path.join(projectPath, '.clubhouse', 'settings.json');
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    if (!raw.defaults) raw.defaults = {};
    if (!raw.quickOverrides) raw.quickOverrides = {};
    return raw;
  } catch {
    return { defaults: {}, quickOverrides: {} };
  }
}

function writeSettings(projectPath: string, settings: ProjectSettings): void {
  const dir = path.join(projectPath, '.clubhouse');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf-8');
}

export function listSourceSkills(projectPath: string): SkillEntry[] {
  const settings = readSettings(projectPath);
  const skillsSubdir = settings.defaultSkillsPath || 'skills';
  const skillsDir = path.join(projectPath, '.clubhouse', skillsSubdir);
  try {
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => {
        const skillPath = path.join(skillsDir, e.name);
        const hasReadme = fs.existsSync(path.join(skillPath, 'README.md'));
        return { name: e.name, path: skillPath, hasReadme };
      });
  } catch {
    return [];
  }
}

export function listSourceAgentTemplates(projectPath: string): AgentTemplateEntry[] {
  const settings = readSettings(projectPath);
  const agentsSubdir = settings.defaultAgentsPath || 'agent-templates';
  const agentsDir = path.join(projectPath, '.clubhouse', agentsSubdir);
  try {
    const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => {
        const agentPath = path.join(agentsDir, e.name);
        const hasReadme = fs.existsSync(path.join(agentPath, 'README.md'));
        return { name: e.name, path: agentPath, hasReadme };
      });
  } catch {
    return [];
  }
}

function makeTemplateReadme(kind: 'skill' | 'agent', name: string): string {
  const label = kind === 'skill' ? 'Skill' : 'Agent';
  return `---\n# ${label}: ${name}\n---\n\n# ${name}\n\nDescribe what this ${kind} does.\n`;
}

export function createSkillDir(basePath: string, name: string, isSource: boolean): string {
  const dir = isSource
    ? path.join(basePath, name)
    : path.join(basePath, '.claude', 'skills', name);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const readmePath = path.join(dir, 'README.md');
  if (!fs.existsSync(readmePath)) {
    fs.writeFileSync(readmePath, makeTemplateReadme('skill', name), 'utf-8');
  }

  // Auto-set defaultSkillsPath if this is the first source skill
  if (isSource) {
    const projectPath = path.resolve(basePath, '..', '..');
    // Only if basePath is under .clubhouse/
    if (basePath.includes(path.join('.clubhouse', ''))) {
      const settings = readSettings(projectPath);
      if (!settings.defaultSkillsPath) {
        const relative = path.relative(path.join(projectPath, '.clubhouse'), basePath);
        settings.defaultSkillsPath = relative;
        writeSettings(projectPath, settings);
      }
    }
  }

  return readmePath;
}

export function createAgentTemplateDir(basePath: string, name: string, isSource: boolean): string {
  const dir = isSource
    ? path.join(basePath, name)
    : path.join(basePath, '.claude', 'agents', name);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const readmePath = path.join(dir, 'README.md');
  if (!fs.existsSync(readmePath)) {
    fs.writeFileSync(readmePath, makeTemplateReadme('agent', name), 'utf-8');
  }

  // Auto-set defaultAgentsPath if this is the first source agent template
  if (isSource) {
    const projectPath = path.resolve(basePath, '..', '..');
    if (basePath.includes(path.join('.clubhouse', ''))) {
      const settings = readSettings(projectPath);
      if (!settings.defaultAgentsPath) {
        const relative = path.relative(path.join(projectPath, '.clubhouse'), basePath);
        settings.defaultAgentsPath = relative;
        writeSettings(projectPath, settings);
      }
    }
  }

  return readmePath;
}

/**
 * Read permissions from .claude/settings.local.json in the given worktree.
 * Returns { allow?: string[], deny?: string[] }.
 */
export function readPermissions(worktreePath: string): PermissionsConfig {
  const settingsPath = path.join(worktreePath, '.claude', 'settings.local.json');
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const perms = raw.permissions;
    if (!perms || typeof perms !== 'object') return {};
    return {
      allow: Array.isArray(perms.allow) ? perms.allow : undefined,
      deny: Array.isArray(perms.deny) ? perms.deny : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Write permissions to .claude/settings.local.json in the given worktree.
 * Merges with existing file content (preserves hooks and other settings).
 */
export function writePermissions(worktreePath: string, permissions: PermissionsConfig): void {
  const claudeDir = path.join(worktreePath, '.claude');
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }

  const settingsPath = path.join(claudeDir, 'settings.local.json');

  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch {
    // File doesn't exist or is invalid
  }

  // Build the permissions object, omitting empty arrays
  const permsObj: Record<string, string[]> = {};
  if (permissions.allow && permissions.allow.length > 0) {
    permsObj.allow = permissions.allow;
  }
  if (permissions.deny && permissions.deny.length > 0) {
    permsObj.deny = permissions.deny;
  }

  const merged: Record<string, unknown> = { ...existing };
  if (Object.keys(permsObj).length > 0) {
    merged.permissions = permsObj;
  } else {
    delete merged.permissions;
  }

  fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2), 'utf-8');
}
