import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { McpServerEntry, SkillEntry, AgentTemplateEntry, PermissionsConfig, ProjectAgentDefaults, LaunchWrapperConfig, McpCatalogEntry } from '../../shared/types';
import { appLog } from './log-service';
import { pathExists } from './fs-utils';

const LOG_NS = 'core:agent-settings';

/**
 * Orchestrator convention paths used by settings functions.
 * When omitted, functions fall back to Claude Code defaults for backward compatibility.
 */
export interface SettingsConventions {
  configDir: string;           // e.g. '.claude', '.github', '.codex'
  skillsDir: string;           // e.g. 'skills'
  agentTemplatesDir: string;   // e.g. 'agents'
  mcpConfigFile: string;       // e.g. '.mcp.json', '.github/mcp.json'
  localSettingsFile: string;   // e.g. 'settings.local.json', 'hooks/hooks.json'
  settingsFormat?: 'json' | 'toml';  // defaults to 'json'
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
  launchWrapper?: LaunchWrapperConfig;
  mcpCatalog?: McpCatalogEntry[];
  defaultMcps?: string[];
}

export async function readClaudeMd(worktreePath: string): Promise<string> {
  const filePath = path.join(worktreePath, 'CLAUDE.md');
  try {
    return await fsp.readFile(filePath, 'utf-8');
  } catch (err) {
    appLog(LOG_NS, 'warn', `Failed to read CLAUDE.md at ${filePath}`, { meta: { error: err instanceof Error ? err.message : String(err) } });
    return '';
  }
}

export async function writeClaudeMd(worktreePath: string, content: string): Promise<void> {
  const filePath = path.join(worktreePath, 'CLAUDE.md');
  await fsp.writeFile(filePath, content, 'utf-8');
}

async function parseMcpServers(filePath: string, scope: 'project' | 'global'): Promise<McpServerEntry[]> {
  try {
    const raw = await fsp.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    const servers = parsed.mcpServers || {};
    return Object.entries(servers).map(([name, config]: [string, Record<string, unknown>]) => ({
      name,
      command: (config.command as string) || '',
      args: config.args as string[] | undefined,
      env: config.env as Record<string, string> | undefined,
      scope,
    }));
  } catch (err) {
    appLog(LOG_NS, 'warn', `Failed to parse MCP config from ${filePath}`, { meta: { error: err instanceof Error ? err.message : String(err) } });
    return [];
  }
}

export async function readMcpConfig(worktreePath: string, conv?: SettingsConventions): Promise<McpServerEntry[]> {
  const c = conv || CLAUDE_CODE_CONVENTIONS;
  const [projectServers, globalServers] = await Promise.all([
    parseMcpServers(path.join(worktreePath, c.mcpConfigFile), 'project'),
    parseMcpServers(path.join(os.homedir(), '.claude.json'), 'global'),
  ]);

  // Dedupe: project-scoped servers take priority over global ones with the same name
  const seen = new Set(projectServers.map((s) => s.name));
  const uniqueGlobal = globalServers.filter((s) => !seen.has(s.name));

  return [...projectServers, ...uniqueGlobal];
}

export async function listSkills(worktreePath: string, conv?: SettingsConventions): Promise<SkillEntry[]> {
  const c = conv || CLAUDE_CODE_CONVENTIONS;
  const skillsDir = path.join(worktreePath, c.configDir, c.skillsDir);
  try {
    const entries = await fsp.readdir(skillsDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory());
    return Promise.all(dirs.map(async (e) => {
      const skillPath = path.join(skillsDir, e.name);
      const hasReadme = await pathExists(path.join(skillPath, 'README.md'));
      return { name: e.name, path: skillPath, hasReadme };
    }));
  } catch (err) {
    appLog(LOG_NS, 'warn', `Failed to list skills from ${skillsDir}`, { meta: { error: err instanceof Error ? err.message : String(err) } });
    return [];
  }
}

export async function listAgentTemplates(worktreePath: string, conv?: SettingsConventions): Promise<AgentTemplateEntry[]> {
  const c = conv || CLAUDE_CODE_CONVENTIONS;
  const agentsDir = path.join(worktreePath, c.configDir, c.agentTemplatesDir);
  try {
    const entries = await fsp.readdir(agentsDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory());
    return Promise.all(dirs.map(async (e) => {
      const agentPath = path.join(agentsDir, e.name);
      const hasReadme = await pathExists(path.join(agentPath, 'README.md'));
      return { name: e.name, path: agentPath, hasReadme };
    }));
  } catch (err) {
    appLog(LOG_NS, 'warn', `Failed to list agent templates from ${agentsDir}`, { meta: { error: err instanceof Error ? err.message : String(err) } });
    return [];
  }
}

async function readSettings(projectPath: string): Promise<ProjectSettings> {
  const settingsFile = path.join(projectPath, '.clubhouse', 'settings.json');
  try {
    const raw = JSON.parse(await fsp.readFile(settingsFile, 'utf-8'));
    if (!raw.defaults) raw.defaults = {};
    if (!raw.quickOverrides) raw.quickOverrides = {};
    return raw;
  } catch (err) {
    appLog(LOG_NS, 'warn', `Failed to read project settings from ${settingsFile}`, { meta: { error: err instanceof Error ? err.message : String(err) } });
    return { defaults: {}, quickOverrides: {} };
  }
}

async function writeSettings(projectPath: string, settings: ProjectSettings): Promise<void> {
  const dir = path.join(projectPath, '.clubhouse');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf-8');
}

export async function listSourceSkills(projectPath: string): Promise<SkillEntry[]> {
  const settings = await readSettings(projectPath);
  const skillsSubdir = settings.defaultSkillsPath || 'skills';
  const skillsDir = path.join(projectPath, '.clubhouse', skillsSubdir);
  try {
    const entries = await fsp.readdir(skillsDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory());
    return Promise.all(dirs.map(async (e) => {
      const skillPath = path.join(skillsDir, e.name);
      const hasReadme = await pathExists(path.join(skillPath, 'README.md'));
      return { name: e.name, path: skillPath, hasReadme };
    }));
  } catch (err) {
    appLog(LOG_NS, 'warn', `Failed to list source skills from ${skillsDir}`, { meta: { error: err instanceof Error ? err.message : String(err) } });
    return [];
  }
}

export async function listSourceAgentTemplates(projectPath: string): Promise<AgentTemplateEntry[]> {
  const settings = await readSettings(projectPath);
  const agentsSubdir = settings.defaultAgentsPath || 'agent-templates';
  const agentsDir = path.join(projectPath, '.clubhouse', agentsSubdir);
  try {
    const entries = await fsp.readdir(agentsDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory());
    return Promise.all(dirs.map(async (e) => {
      const agentPath = path.join(agentsDir, e.name);
      const hasReadme = await pathExists(path.join(agentPath, 'README.md'));
      return { name: e.name, path: agentPath, hasReadme };
    }));
  } catch (err) {
    appLog(LOG_NS, 'warn', `Failed to list source agent templates from ${agentsDir}`, { meta: { error: err instanceof Error ? err.message : String(err) } });
    return [];
  }
}

/**
 * Read the content of a source skill's SKILL.md file (project-level .clubhouse/skills/).
 */
export async function readSourceSkillContent(projectPath: string, skillName: string): Promise<string> {
  const settings = await readSettings(projectPath);
  const skillsSubdir = settings.defaultSkillsPath || 'skills';
  const filePath = path.join(projectPath, '.clubhouse', skillsSubdir, skillName, 'SKILL.md');
  try {
    return await fsp.readFile(filePath, 'utf-8');
  } catch (err) {
    appLog(LOG_NS, 'warn', `Failed to read source skill content at ${filePath}`, { meta: { error: err instanceof Error ? err.message : String(err) } });
    return '';
  }
}

/**
 * Write the content of a source skill's SKILL.md file.
 */
export async function writeSourceSkillContent(projectPath: string, skillName: string, content: string): Promise<void> {
  const settings = await readSettings(projectPath);
  const skillsSubdir = settings.defaultSkillsPath || 'skills';
  const dir = path.join(projectPath, '.clubhouse', skillsSubdir, skillName);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'SKILL.md'), content, 'utf-8');
}

/**
 * Delete a source skill directory.
 */
export async function deleteSourceSkill(projectPath: string, skillName: string): Promise<void> {
  const settings = await readSettings(projectPath);
  const skillsSubdir = settings.defaultSkillsPath || 'skills';
  const dir = path.join(projectPath, '.clubhouse', skillsSubdir, skillName);
  await fsp.rm(dir, { recursive: true, force: true });
}

/**
 * Read the content of a source agent template's README.md file (project-level .clubhouse/agent-templates/).
 */
export async function readSourceAgentTemplateContent(projectPath: string, agentName: string): Promise<string> {
  const settings = await readSettings(projectPath);
  const agentsSubdir = settings.defaultAgentsPath || 'agent-templates';
  const filePath = path.join(projectPath, '.clubhouse', agentsSubdir, agentName, 'README.md');
  try {
    return await fsp.readFile(filePath, 'utf-8');
  } catch (err) {
    appLog(LOG_NS, 'warn', `Failed to read source agent template at ${filePath}`, { meta: { error: err instanceof Error ? err.message : String(err) } });
    return '';
  }
}

/**
 * Write the content of a source agent template's README.md file.
 */
export async function writeSourceAgentTemplateContent(projectPath: string, agentName: string, content: string): Promise<void> {
  const settings = await readSettings(projectPath);
  const agentsSubdir = settings.defaultAgentsPath || 'agent-templates';
  const dir = path.join(projectPath, '.clubhouse', agentsSubdir, agentName);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'README.md'), content, 'utf-8');
}

/**
 * Delete a source agent template directory.
 */
export async function deleteSourceAgentTemplate(projectPath: string, agentName: string): Promise<void> {
  const settings = await readSettings(projectPath);
  const agentsSubdir = settings.defaultAgentsPath || 'agent-templates';
  const dir = path.join(projectPath, '.clubhouse', agentsSubdir, agentName);
  await fsp.rm(dir, { recursive: true, force: true });
}

function makeTemplateReadme(kind: 'skill' | 'agent', name: string): string {
  const label = kind === 'skill' ? 'Skill' : 'Agent';
  return `---\n# ${label}: ${name}\n---\n\n# ${name}\n\nDescribe what this ${kind} does.\n`;
}

export async function createSkillDir(basePath: string, name: string, isSource: boolean, conv?: SettingsConventions): Promise<string> {
  const c = conv || CLAUDE_CODE_CONVENTIONS;
  const dir = isSource
    ? path.join(basePath, name)
    : path.join(basePath, c.configDir, c.skillsDir, name);
  await fsp.mkdir(dir, { recursive: true });
  const readmePath = path.join(dir, 'README.md');
  if (!(await pathExists(readmePath))) {
    await fsp.writeFile(readmePath, makeTemplateReadme('skill', name), 'utf-8');
  }

  // Auto-set defaultSkillsPath if this is the first source skill
  if (isSource) {
    const projectPath = path.resolve(basePath, '..', '..');
    // Only if basePath is under .clubhouse/
    if (basePath.includes(path.join('.clubhouse', ''))) {
      const settings = await readSettings(projectPath);
      if (!settings.defaultSkillsPath) {
        const relative = path.relative(path.join(projectPath, '.clubhouse'), basePath);
        settings.defaultSkillsPath = relative;
        await writeSettings(projectPath, settings);
      }
    }
  }

  return readmePath;
}

export async function createAgentTemplateDir(basePath: string, name: string, isSource: boolean, conv?: SettingsConventions): Promise<string> {
  const c = conv || CLAUDE_CODE_CONVENTIONS;
  const dir = isSource
    ? path.join(basePath, name)
    : path.join(basePath, c.configDir, c.agentTemplatesDir, name);
  await fsp.mkdir(dir, { recursive: true });
  const readmePath = path.join(dir, 'README.md');
  if (!(await pathExists(readmePath))) {
    await fsp.writeFile(readmePath, makeTemplateReadme('agent', name), 'utf-8');
  }

  // Auto-set defaultAgentsPath if this is the first source agent template
  if (isSource) {
    const projectPath = path.resolve(basePath, '..', '..');
    if (basePath.includes(path.join('.clubhouse', ''))) {
      const settings = await readSettings(projectPath);
      if (!settings.defaultAgentsPath) {
        const relative = path.relative(path.join(projectPath, '.clubhouse'), basePath);
        settings.defaultAgentsPath = relative;
        await writeSettings(projectPath, settings);
      }
    }
  }

  return readmePath;
}

/**
 * Read permissions from .claude/settings.local.json in the given worktree.
 * Returns { allow?: string[], deny?: string[] }.
 */
export async function readPermissions(worktreePath: string, conv?: SettingsConventions): Promise<PermissionsConfig> {
  const c = conv || CLAUDE_CODE_CONVENTIONS;
  // Non-JSON settings files (e.g. TOML) are not supported — return empty
  if (c.settingsFormat && c.settingsFormat !== 'json') return {};
  const settingsPath = path.join(worktreePath, c.configDir, c.localSettingsFile);
  try {
    const raw = JSON.parse(await fsp.readFile(settingsPath, 'utf-8'));
    const perms = raw.permissions;
    if (!perms || typeof perms !== 'object') return {};
    return {
      allow: Array.isArray(perms.allow) ? perms.allow : undefined,
      deny: Array.isArray(perms.deny) ? perms.deny : undefined,
    };
  } catch (err) {
    appLog(LOG_NS, 'warn', `Failed to read permissions from ${settingsPath}`, { meta: { error: err instanceof Error ? err.message : String(err) } });
    return {};
  }
}

/**
 * Read the content of a skill's SKILL.md file.
 * Uses conventions to resolve the correct config directory.
 */
export async function readSkillContent(worktreePath: string, skillName: string, conv?: SettingsConventions): Promise<string> {
  const c = conv || CLAUDE_CODE_CONVENTIONS;
  const filePath = path.join(worktreePath, c.configDir, c.skillsDir, skillName, 'SKILL.md');
  try {
    return await fsp.readFile(filePath, 'utf-8');
  } catch (err) {
    appLog(LOG_NS, 'warn', `Failed to read skill content at ${filePath}`, { meta: { error: err instanceof Error ? err.message : String(err) } });
    return '';
  }
}

/**
 * Write the content of a skill's SKILL.md file, creating the directory if needed.
 */
export async function writeSkillContent(worktreePath: string, skillName: string, content: string, conv?: SettingsConventions): Promise<void> {
  const c = conv || CLAUDE_CODE_CONVENTIONS;
  const dir = path.join(worktreePath, c.configDir, c.skillsDir, skillName);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'SKILL.md'), content, 'utf-8');
}

/**
 * Delete a skill directory and all its contents.
 */
export async function deleteSkill(worktreePath: string, skillName: string, conv?: SettingsConventions): Promise<void> {
  const c = conv || CLAUDE_CODE_CONVENTIONS;
  const dir = path.join(worktreePath, c.configDir, c.skillsDir, skillName);
  await fsp.rm(dir, { recursive: true, force: true });
}

/**
 * Read the content of an agent template markdown file.
 */
export async function readAgentTemplateContent(worktreePath: string, agentName: string, conv?: SettingsConventions): Promise<string> {
  const c = conv || CLAUDE_CODE_CONVENTIONS;
  const filePath = path.join(worktreePath, c.configDir, c.agentTemplatesDir, agentName + '.md');
  try {
    return await fsp.readFile(filePath, 'utf-8');
  } catch {
    // Fallback: check if it's a directory-based template
    const dirPath = path.join(worktreePath, c.configDir, c.agentTemplatesDir, agentName, 'README.md');
    try {
      return await fsp.readFile(dirPath, 'utf-8');
    } catch (err) {
      appLog(LOG_NS, 'warn', `Failed to read agent template "${agentName}" (tried .md and directory forms)`, { meta: { error: err instanceof Error ? err.message : String(err) } });
      return '';
    }
  }
}

/**
 * Write the content of an agent template markdown file, creating directory if needed.
 */
export async function writeAgentTemplateContent(worktreePath: string, agentName: string, content: string, conv?: SettingsConventions): Promise<void> {
  const c = conv || CLAUDE_CODE_CONVENTIONS;
  const dir = path.join(worktreePath, c.configDir, c.agentTemplatesDir);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, agentName + '.md'), content, 'utf-8');
}

/**
 * Delete an agent template (both .md file and directory forms).
 */
export async function deleteAgentTemplate(worktreePath: string, agentName: string, conv?: SettingsConventions): Promise<void> {
  const c = conv || CLAUDE_CODE_CONVENTIONS;
  const baseDir = path.join(worktreePath, c.configDir, c.agentTemplatesDir);
  const filePath = path.join(baseDir, agentName + '.md');
  if (await pathExists(filePath)) {
    await fsp.unlink(filePath);
  }
  const dirPath = path.join(baseDir, agentName);
  await fsp.rm(dirPath, { recursive: true, force: true });
}

/**
 * List agent template .md files and directories under the agent templates dir.
 */
export async function listAgentTemplateFiles(worktreePath: string, conv?: SettingsConventions): Promise<AgentTemplateEntry[]> {
  const c = conv || CLAUDE_CODE_CONVENTIONS;
  const agentsDir = path.join(worktreePath, c.configDir, c.agentTemplatesDir);
  try {
    const entries = await fsp.readdir(agentsDir, { withFileTypes: true });
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
        const hasReadme = await pathExists(path.join(agentPath, 'README.md'));
        // Skip if already listed as .md file
        if (!results.find((r) => r.name === e.name)) {
          results.push({ name: e.name, path: agentPath, hasReadme });
        }
      }
    }
    return results;
  } catch (err) {
    appLog(LOG_NS, 'warn', `Failed to list agent template files from ${agentsDir}`, { meta: { error: err instanceof Error ? err.message : String(err) } });
    return [];
  }
}

/**
 * Read the raw MCP config file content as a string.
 * Uses conventions to resolve the correct MCP config file path.
 */
export async function readMcpRawJson(worktreePath: string, conv?: SettingsConventions): Promise<string> {
  const c = conv || CLAUDE_CODE_CONVENTIONS;
  // Non-JSON config files (e.g. TOML) cannot be read as JSON — return empty default
  if (c.settingsFormat && c.settingsFormat !== 'json') return '{\n  "mcpServers": {}\n}';
  const filePath = path.join(worktreePath, c.mcpConfigFile);
  try {
    return await fsp.readFile(filePath, 'utf-8');
  } catch (err) {
    appLog(LOG_NS, 'warn', `Failed to read MCP config from ${filePath}`, { meta: { error: err instanceof Error ? err.message : String(err) } });
    return '{\n  "mcpServers": {}\n}';
  }
}

/**
 * Write raw JSON string to MCP config file. Validates JSON before writing.
 * Returns { ok: true } on success, or { ok: false, error: string } on parse failure.
 */
export async function writeMcpRawJson(worktreePath: string, content: string, conv?: SettingsConventions): Promise<{ ok: boolean; error?: string }> {
  const c = conv || CLAUDE_CODE_CONVENTIONS;
  // Non-JSON config files (e.g. TOML) — refuse to write JSON content
  if (c.settingsFormat && c.settingsFormat !== 'json') {
    return { ok: false, error: 'MCP config writes are not supported for non-JSON settings formats' };
  }
  try {
    JSON.parse(content); // Validate
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Invalid JSON' };
  }
  const filePath = path.join(worktreePath, c.mcpConfigFile);
  // Ensure parent directory exists (e.g. .github/ for copilot)
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(filePath, content, 'utf-8');
  return { ok: true };
}

/**
 * Write permissions to .claude/settings.local.json in the given worktree.
 * Merges with existing file content (preserves hooks and other settings).
 */
export async function writePermissions(worktreePath: string, permissions: PermissionsConfig, conv?: SettingsConventions): Promise<void> {
  const c = conv || CLAUDE_CODE_CONVENTIONS;
  // Non-JSON settings files (e.g. TOML) are not supported — skip write
  if (c.settingsFormat && c.settingsFormat !== 'json') return;
  const settingsPath = path.join(worktreePath, c.configDir, c.localSettingsFile);
  const settingsDir = path.dirname(settingsPath);
  await fsp.mkdir(settingsDir, { recursive: true });

  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await fsp.readFile(settingsPath, 'utf-8'));
  } catch (err) {
    appLog(LOG_NS, 'warn', `Failed to read existing settings at ${settingsPath}, starting fresh`, { meta: { error: err instanceof Error ? err.message : String(err) } });
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

  await fsp.writeFile(settingsPath, JSON.stringify(merged, null, 2), 'utf-8');
}

/**
 * Read project-level agent defaults from .clubhouse/settings.json.
 */
export async function readProjectAgentDefaults(projectPath: string): Promise<ProjectAgentDefaults> {
  const settings = await readSettings(projectPath);
  return settings.agentDefaults || {};
}

/**
 * Write project-level agent defaults to .clubhouse/settings.json.
 */
export async function writeProjectAgentDefaults(projectPath: string, defaults: ProjectAgentDefaults): Promise<void> {
  const settings = await readSettings(projectPath);
  settings.agentDefaults = defaults;
  await writeSettings(projectPath, settings);
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
export async function applyAgentDefaults(
  worktreePath: string,
  projectPath: string,
  writeInstructions?: (worktreePath: string, content: string) => void,
  conv?: SettingsConventions,
): Promise<void> {
  const c = conv || CLAUDE_CODE_CONVENTIONS;
  const defaults = await readProjectAgentDefaults(projectPath);
  if (!defaults) return;

  if (defaults.instructions) {
    if (writeInstructions) {
      writeInstructions(worktreePath, defaults.instructions);
    } else {
      await writeClaudeMd(worktreePath, defaults.instructions);
    }
  }

  if (defaults.permissions) {
    await writePermissions(worktreePath, defaults.permissions, conv);
  }

  if (defaults.mcpJson) {
    try {
      const mcpPath = path.join(worktreePath, c.mcpConfigFile);
      const dir = path.dirname(mcpPath);
      await fsp.mkdir(dir, { recursive: true });

      if (c.settingsFormat === 'toml') {
        const { jsonMcpToToml } = await import('./toml-utils');
        const tomlContent = jsonMcpToToml(defaults.mcpJson);
        if (tomlContent) {
          await fsp.writeFile(mcpPath, tomlContent, 'utf-8');
        }
      } else {
        JSON.parse(defaults.mcpJson); // Validate before writing
        await fsp.writeFile(mcpPath, defaults.mcpJson, 'utf-8');
      }
    } catch (err) {
      appLog(LOG_NS, 'warn', 'Skipped invalid MCP config in agent defaults', { meta: { error: err instanceof Error ? err.message : String(err) } });
    }
  }
}

/**
 * Read the launch wrapper config from .clubhouse/settings.json.
 * Returns undefined when no wrapper is configured.
 */
export async function readLaunchWrapper(projectPath: string): Promise<LaunchWrapperConfig | undefined> {
  const settings = await readSettings(projectPath);
  return settings.launchWrapper;
}

/**
 * Read the MCP catalog from .clubhouse/settings.json.
 * Returns an empty array when no catalog is configured.
 */
export async function readMcpCatalog(projectPath: string): Promise<McpCatalogEntry[]> {
  const settings = await readSettings(projectPath);
  return settings.mcpCatalog || [];
}

/**
 * Read the project default MCP IDs from .clubhouse/settings.json.
 * Returns an empty array when no defaults are configured.
 */
export async function readDefaultMcps(projectPath: string): Promise<string[]> {
  const settings = await readSettings(projectPath);
  return settings.defaultMcps || [];
}

/**
 * Write the launch wrapper config to .clubhouse/settings.json.
 * Pass undefined to remove the wrapper.
 */
export async function writeLaunchWrapper(projectPath: string, wrapper: LaunchWrapperConfig | undefined): Promise<void> {
  const settings = await readSettings(projectPath);
  if (wrapper) {
    settings.launchWrapper = wrapper;
  } else {
    delete settings.launchWrapper;
  }
  await writeSettings(projectPath, settings);
}

/**
 * Write the MCP catalog to .clubhouse/settings.json.
 */
export async function writeMcpCatalog(projectPath: string, catalog: McpCatalogEntry[]): Promise<void> {
  const settings = await readSettings(projectPath);
  settings.mcpCatalog = catalog;
  await writeSettings(projectPath, settings);
}

/**
 * Write project default MCP IDs to .clubhouse/settings.json.
 */
export async function writeDefaultMcps(projectPath: string, mcpIds: string[]): Promise<void> {
  const settings = await readSettings(projectPath);
  settings.defaultMcps = mcpIds;
  await writeSettings(projectPath, settings);
}
