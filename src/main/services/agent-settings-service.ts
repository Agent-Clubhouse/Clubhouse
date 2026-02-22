import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { McpServerEntry, SkillEntry, AgentTemplateEntry, PermissionsConfig, ProjectAgentDefaults } from '../../shared/types';

/**
 * Orchestrator convention paths used by settings functions.
 * When omitted, functions fall back to Claude Code defaults for backward compatibility.
 */
export interface SettingsConventions {
  configDir: string;           // e.g. '.claude', '.github', '.opencode'
  skillsDir: string;           // e.g. 'skills'
  agentTemplatesDir: string;   // e.g. 'agents'
  mcpConfigFile: string;       // e.g. '.mcp.json', '.github/mcp.json'
  localSettingsFile: string;   // e.g. 'settings.local.json', 'hooks/hooks.json'
}

const CLAUDE_CODE_CONVENTIONS: SettingsConventions = {
  configDir: '.claude',
  skillsDir: 'skills',
  agentTemplatesDir: 'agents',
  mcpConfigFile: '.mcp.json',
  localSettingsFile: 'settings.local.json',
};

/** Local settings shape for .clubhouse/settings.json */
interface ProjectSettings {
  defaults: Record<string, unknown>;
  quickOverrides: Record<string, unknown>;
  defaultSkillsPath?: string;
  defaultAgentsPath?: string;
  agentDefaults?: ProjectAgentDefaults;
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

export function readMcpConfig(worktreePath: string, conv?: SettingsConventions): McpServerEntry[] {
  const c = conv || CLAUDE_CODE_CONVENTIONS;
  const projectServers = parseMcpServers(path.join(worktreePath, c.mcpConfigFile), 'project');
  const globalServers = parseMcpServers(path.join(os.homedir(), '.claude.json'), 'global');

  // Dedupe: project-scoped servers take priority over global ones with the same name
  const seen = new Set(projectServers.map((s) => s.name));
  const uniqueGlobal = globalServers.filter((s) => !seen.has(s.name));

  return [...projectServers, ...uniqueGlobal];
}

export function listSkills(worktreePath: string, conv?: SettingsConventions): SkillEntry[] {
  const c = conv || CLAUDE_CODE_CONVENTIONS;
  const skillsDir = path.join(worktreePath, c.configDir, c.skillsDir);
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

export function listAgentTemplates(worktreePath: string, conv?: SettingsConventions): AgentTemplateEntry[] {
  const c = conv || CLAUDE_CODE_CONVENTIONS;
  const agentsDir = path.join(worktreePath, c.configDir, c.agentTemplatesDir);
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

/**
 * Read the content of a source skill's SKILL.md file (project-level .clubhouse/skills/).
 */
export function readSourceSkillContent(projectPath: string, skillName: string): string {
  const settings = readSettings(projectPath);
  const skillsSubdir = settings.defaultSkillsPath || 'skills';
  const filePath = path.join(projectPath, '.clubhouse', skillsSubdir, skillName, 'SKILL.md');
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Write the content of a source skill's SKILL.md file.
 */
export function writeSourceSkillContent(projectPath: string, skillName: string, content: string): void {
  const settings = readSettings(projectPath);
  const skillsSubdir = settings.defaultSkillsPath || 'skills';
  const dir = path.join(projectPath, '.clubhouse', skillsSubdir, skillName);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf-8');
}

/**
 * Delete a source skill directory.
 */
export function deleteSourceSkill(projectPath: string, skillName: string): void {
  const settings = readSettings(projectPath);
  const skillsSubdir = settings.defaultSkillsPath || 'skills';
  const dir = path.join(projectPath, '.clubhouse', skillsSubdir, skillName);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Read the content of a source agent template's README.md file (project-level .clubhouse/agent-templates/).
 */
export function readSourceAgentTemplateContent(projectPath: string, agentName: string): string {
  const settings = readSettings(projectPath);
  const agentsSubdir = settings.defaultAgentsPath || 'agent-templates';
  const filePath = path.join(projectPath, '.clubhouse', agentsSubdir, agentName, 'README.md');
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Write the content of a source agent template's README.md file.
 */
export function writeSourceAgentTemplateContent(projectPath: string, agentName: string, content: string): void {
  const settings = readSettings(projectPath);
  const agentsSubdir = settings.defaultAgentsPath || 'agent-templates';
  const dir = path.join(projectPath, '.clubhouse', agentsSubdir, agentName);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), content, 'utf-8');
}

/**
 * Delete a source agent template directory.
 */
export function deleteSourceAgentTemplate(projectPath: string, agentName: string): void {
  const settings = readSettings(projectPath);
  const agentsSubdir = settings.defaultAgentsPath || 'agent-templates';
  const dir = path.join(projectPath, '.clubhouse', agentsSubdir, agentName);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function makeTemplateReadme(kind: 'skill' | 'agent', name: string): string {
  const label = kind === 'skill' ? 'Skill' : 'Agent';
  return `---\n# ${label}: ${name}\n---\n\n# ${name}\n\nDescribe what this ${kind} does.\n`;
}

export function createSkillDir(basePath: string, name: string, isSource: boolean, conv?: SettingsConventions): string {
  const c = conv || CLAUDE_CODE_CONVENTIONS;
  const dir = isSource
    ? path.join(basePath, name)
    : path.join(basePath, c.configDir, c.skillsDir, name);
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

export function createAgentTemplateDir(basePath: string, name: string, isSource: boolean, conv?: SettingsConventions): string {
  const c = conv || CLAUDE_CODE_CONVENTIONS;
  const dir = isSource
    ? path.join(basePath, name)
    : path.join(basePath, c.configDir, c.agentTemplatesDir, name);
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
export function readPermissions(worktreePath: string, conv?: SettingsConventions): PermissionsConfig {
  const c = conv || CLAUDE_CODE_CONVENTIONS;
  const settingsPath = path.join(worktreePath, c.configDir, c.localSettingsFile);
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
 * Read the content of a skill's SKILL.md file.
 * Uses conventions to resolve the correct config directory.
 */
export function readSkillContent(worktreePath: string, skillName: string, conv?: SettingsConventions): string {
  const c = conv || CLAUDE_CODE_CONVENTIONS;
  const filePath = path.join(worktreePath, c.configDir, c.skillsDir, skillName, 'SKILL.md');
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Write the content of a skill's SKILL.md file, creating the directory if needed.
 */
export function writeSkillContent(worktreePath: string, skillName: string, content: string, conv?: SettingsConventions): void {
  const c = conv || CLAUDE_CODE_CONVENTIONS;
  const dir = path.join(worktreePath, c.configDir, c.skillsDir, skillName);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf-8');
}

/**
 * Delete a skill directory and all its contents.
 */
export function deleteSkill(worktreePath: string, skillName: string, conv?: SettingsConventions): void {
  const c = conv || CLAUDE_CODE_CONVENTIONS;
  const dir = path.join(worktreePath, c.configDir, c.skillsDir, skillName);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Read the content of an agent template markdown file.
 */
export function readAgentTemplateContent(worktreePath: string, agentName: string, conv?: SettingsConventions): string {
  const c = conv || CLAUDE_CODE_CONVENTIONS;
  const filePath = path.join(worktreePath, c.configDir, c.agentTemplatesDir, agentName + '.md');
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    // Fallback: check if it's a directory-based template
    const dirPath = path.join(worktreePath, c.configDir, c.agentTemplatesDir, agentName, 'README.md');
    try {
      return fs.readFileSync(dirPath, 'utf-8');
    } catch {
      return '';
    }
  }
}

/**
 * Write the content of an agent template markdown file, creating directory if needed.
 */
export function writeAgentTemplateContent(worktreePath: string, agentName: string, content: string, conv?: SettingsConventions): void {
  const c = conv || CLAUDE_CODE_CONVENTIONS;
  const dir = path.join(worktreePath, c.configDir, c.agentTemplatesDir);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, agentName + '.md'), content, 'utf-8');
}

/**
 * Delete an agent template (both .md file and directory forms).
 */
export function deleteAgentTemplate(worktreePath: string, agentName: string, conv?: SettingsConventions): void {
  const c = conv || CLAUDE_CODE_CONVENTIONS;
  const baseDir = path.join(worktreePath, c.configDir, c.agentTemplatesDir);
  const filePath = path.join(baseDir, agentName + '.md');
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
  const dirPath = path.join(baseDir, agentName);
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}

/**
 * List agent template .md files and directories under the agent templates dir.
 */
export function listAgentTemplateFiles(worktreePath: string, conv?: SettingsConventions): AgentTemplateEntry[] {
  const c = conv || CLAUDE_CODE_CONVENTIONS;
  const agentsDir = path.join(worktreePath, c.configDir, c.agentTemplatesDir);
  try {
    const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
    const results: AgentTemplateEntry[] = [];
    // Collect .md files (flat agent definitions)
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.md')) {
        const name = e.name.replace(/\.md$/, '');
        results.push({ name, path: path.join(agentsDir, e.name), hasReadme: false });
      }
    }
    // Also collect directory-based templates
    for (const e of entries) {
      if (e.isDirectory()) {
        const agentPath = path.join(agentsDir, e.name);
        const hasReadme = fs.existsSync(path.join(agentPath, 'README.md'));
        // Skip if already listed as .md file
        if (!results.find((r) => r.name === e.name)) {
          results.push({ name: e.name, path: agentPath, hasReadme });
        }
      }
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * Read the raw MCP config file content as a string.
 * Uses conventions to resolve the correct MCP config file path.
 */
export function readMcpRawJson(worktreePath: string, conv?: SettingsConventions): string {
  const c = conv || CLAUDE_CODE_CONVENTIONS;
  const filePath = path.join(worktreePath, c.mcpConfigFile);
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '{\n  "mcpServers": {}\n}';
  }
}

/**
 * Write raw JSON string to MCP config file. Validates JSON before writing.
 * Returns { ok: true } on success, or { ok: false, error: string } on parse failure.
 */
export function writeMcpRawJson(worktreePath: string, content: string, conv?: SettingsConventions): { ok: boolean; error?: string } {
  const c = conv || CLAUDE_CODE_CONVENTIONS;
  try {
    JSON.parse(content); // Validate
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Invalid JSON' };
  }
  const filePath = path.join(worktreePath, c.mcpConfigFile);
  // Ensure parent directory exists (e.g. .github/ for copilot)
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  return { ok: true };
}

/**
 * Write permissions to .claude/settings.local.json in the given worktree.
 * Merges with existing file content (preserves hooks and other settings).
 */
export function writePermissions(worktreePath: string, permissions: PermissionsConfig, conv?: SettingsConventions): void {
  const c = conv || CLAUDE_CODE_CONVENTIONS;
  const settingsPath = path.join(worktreePath, c.configDir, c.localSettingsFile);
  const settingsDir = path.dirname(settingsPath);
  if (!fs.existsSync(settingsDir)) {
    fs.mkdirSync(settingsDir, { recursive: true });
  }

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

/**
 * Read project-level agent defaults from .clubhouse/settings.json.
 */
export function readProjectAgentDefaults(projectPath: string): ProjectAgentDefaults {
  const settings = readSettings(projectPath);
  return settings.agentDefaults || {};
}

/**
 * Write project-level agent defaults to .clubhouse/settings.json.
 */
export function writeProjectAgentDefaults(projectPath: string, defaults: ProjectAgentDefaults): void {
  const settings = readSettings(projectPath);
  settings.agentDefaults = defaults;
  writeSettings(projectPath, settings);
}

/**
 * Apply project-level agent defaults as snapshots into an agent's worktree.
 * Called during agent creation. Uses the provided writeInstructions function
 * and conventions to write to the correct orchestrator-specific paths.
 *
 * @param worktreePath  - The agent's worktree directory
 * @param projectPath   - The project root (for reading defaults)
 * @param writeInstructions - Orchestrator-specific instructions writer
 * @param conv          - Orchestrator conventions for path resolution
 */
export function applyAgentDefaults(
  worktreePath: string,
  projectPath: string,
  writeInstructions?: (worktreePath: string, content: string) => void,
  conv?: SettingsConventions,
): void {
  const c = conv || CLAUDE_CODE_CONVENTIONS;
  const defaults = readProjectAgentDefaults(projectPath);
  if (!defaults) return;

  if (defaults.instructions) {
    if (writeInstructions) {
      writeInstructions(worktreePath, defaults.instructions);
    } else {
      writeClaudeMd(worktreePath, defaults.instructions);
    }
  }

  if (defaults.permissions) {
    writePermissions(worktreePath, defaults.permissions, conv);
  }

  if (defaults.mcpJson) {
    try {
      JSON.parse(defaults.mcpJson); // Validate before writing
      const mcpPath = path.join(worktreePath, c.mcpConfigFile);
      const dir = path.dirname(mcpPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(mcpPath, defaults.mcpJson, 'utf-8');
    } catch {
      // Skip invalid JSON
    }
  }
}
