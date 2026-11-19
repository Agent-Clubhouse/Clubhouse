import { parseMcpJson } from '../../shared/mcp-config';
import { replaceWildcards, type WildcardContext } from '../../shared/wildcard-replacer';
import { auditChanges, projectAuditTarget, type AuditKeyFormat } from './settings-audit';
import { noteRoutingPolicyChanged } from './helper-routing-changes';
import * as fsp from 'fs/promises';
import { constants as fsConstants, realpathSync, statSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { McpServerEntry, SkillEntry, AgentTemplateEntry, PermissionsConfig, ProjectAgentDefaults, LaunchWrapperConfig, McpCatalogEntry, WrapperCatalogSnapshot } from '../../shared/types';
import { appLog } from './log-service';
import { pathExists } from './fs-utils';
import { backupUnreadableFile, replaceFile } from './settings-store';
import { ensureLocalExcludesOnce } from './local-excludes';
import { validateCommandPrefix } from './command-prefix-validation';

const LOG_NS = 'core:agent-settings';

import { UnsupportedPermissionRulesError } from './permission-rules-error';
import { MANAGED_SKILLS_MANIFEST, MAX_LISTED_SKILLS, skillsFolderOf } from '../../shared/skills-folder';
export { UnsupportedPermissionRulesError } from './permission-rules-error';

/** Check whether an error is a filesystem "file not found" (ENOENT). */
function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/**
 * Orchestrator convention paths used by settings functions.
 * When omitted, functions fall back to Claude Code defaults for backward compatibility.
 */
export interface SettingsConventions {
  configDir: string;           // e.g. '.claude', '.github', '.codex'
  skillsDir: string;           // e.g. 'skills'
  skillsRoot?: string;         // e.g. '.agents/skills' (Codex); see skillsFolderOf
  agentTemplatesDir: string;   // e.g. 'agents'
  mcpConfigFile: string;       // e.g. '.mcp.json', '.github/mcp.json'
  localSettingsFile: string;   // e.g. 'settings.local.json', 'hooks/hooks.json'
  permissionRules?: boolean;
  settingsFormat?: 'json' | 'toml';  // defaults to 'json'
}

const CLAUDE_CODE_CONVENTIONS: SettingsConventions = {
  configDir: '.claude',
  skillsDir: 'skills',
  agentTemplatesDir: 'agents',
  mcpConfigFile: '.mcp.json',
  localSettingsFile: 'settings.local.json',
};

export async function getMcpShadowWarning(worktreePath: string, conv?: SettingsConventions): Promise<string | undefined> {
  const c = conv || CLAUDE_CODE_CONVENTIONS;
  if (!worktreePath || c.mcpConfigFile !== '.github/mcp.json') return undefined;

  const shadowPath = path.join(worktreePath, '.mcp.json');
  if (await pathExists(shadowPath)) {
    return 'Warning: .mcp.json also exists in this worktree and takes precedence over .github/mcp.json. Copilot CLI may ignore the Clubhouse materialized config here.';
  }

  return undefined;
}

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
  wrapperCatalogSnapshot?: WrapperCatalogSnapshot;
  mcpConfigs?: Record<string, Record<string, string>>;
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

async function parseMcpServers(filePath: string, scope: 'project' | 'global', strict = false): Promise<McpServerEntry[]> {
  try {
    const raw = await fsp.readFile(filePath, 'utf-8');
    if (strict) {
      const global: unknown = JSON.parse(raw);
      if (!global || typeof global !== 'object' || Array.isArray(global)) throw new Error('Invalid global MCP configuration.');
      const servers = (global as { mcpServers?: unknown }).mcpServers;
      if (servers === undefined) return [];
      return Object.entries(parseMcpJson(JSON.stringify({ mcpServers: servers }))).map(([name, def]) => ({ name, command: def.command || '', args: def.args, env: def.env, scope }));
    }
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
    if (strict && !isEnoent(err)) throw new Error('MCP configuration is unreadable.');
    if (!isEnoent(err)) {
      appLog(LOG_NS, 'warn', `Failed to parse MCP config from ${filePath}`, { meta: { error: err instanceof Error ? err.message : String(err) } });
    }
    return [];
  }
}

export async function readMcpConfig(worktreePath: string, conv?: SettingsConventions, options: { strict?: boolean } = {}): Promise<McpServerEntry[]> {
  const c = conv || CLAUDE_CODE_CONVENTIONS;
  const raw = await readLocalMcpJson(worktreePath, c);
  const projectServers: McpServerEntry[] = raw === null ? [] : Object.entries(parseMcpJson(raw)).map(([name, def]) => ({
    name, command: def.command || '', args: def.args, env: def.env, scope: 'project',
  }));
  const globalServers = c.configDir === '.claude' ? await parseMcpServers(path.join(os.homedir(), '.claude.json'), 'global', options.strict) : [];

  // Dedupe: project-scoped servers take priority over global ones with the same name
  const seen = new Set(projectServers.map((s) => s.name));
  const uniqueGlobal = globalServers.filter((s) => !seen.has(s.name));

  return [...projectServers, ...uniqueGlobal];
}

export { MAX_LISTED_SKILLS };
/** How much of a SKILL.md is read for its front matter `name`. */
const FRONT_MATTER_BYTES = 8192;

/** The folder names Clubhouse's skills manifest lists, or none. Read only. */
async function managedSkillFolders(skillsDir: string): Promise<Set<string>> {
  try {
    const raw = JSON.parse(await fsp.readFile(path.join(skillsDir, MANAGED_SKILLS_MANIFEST), 'utf-8')) as { skills?: unknown };
    return new Set(Array.isArray(raw?.skills) ? raw.skills.filter((s): s is string => typeof s === 'string') : []);
  } catch {
    // telemetry-exempt: no manifest (or an unreadable one) means Clubhouse delivered none of these.
    return new Set();
  }
}

/** The `name` in front matter text, or undefined. Quoted or bare, without a trailing comment. */
export function frontMatterNameOf(text: string): string | undefined {
  const m = /^---\n([\s\S]*?)\n---/.exec(text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'));
  const raw = m && /^name:[ \t]*(.*)$/m.exec(m[1])?.[1].trim();
  if (!raw) return undefined;
  const quoted = /^"([^"]*)"$/.exec(raw) ?? /^'([^']*)'$/.exec(raw);
  const name = quoted ? quoted[1] : raw.replace(/[ \t]+#.*$/, '');
  return name.trim() || undefined;
}

/**
 * The front matter `name` of a SKILL.md, from its first few KB. Reads text;
 * never runs anything, and reads only a regular file, so a link out of the
 * folder (or to a pipe) isn't followed.
 */
async function frontMatterName(skillPath: string): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof fsp.open>> | undefined;
  try {
    const file = path.join(skillPath, 'SKILL.md');
    if (!(await fsp.lstat(file)).isFile()) return undefined;
    // No following a link swapped in after the check, and no waiting on a pipe (where the platform has the flags).
    handle = await fsp.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    const buf = Buffer.alloc(FRONT_MATTER_BYTES);
    const { bytesRead } = await handle.read(buf, 0, FRONT_MATTER_BYTES, 0);
    return frontMatterNameOf(buf.subarray(0, bytesRead).toString('utf-8'));
  } catch {
    // telemetry-exempt: no SKILL.md, or not readable: the folder name stands.
    return undefined;
  } finally {
    await handle?.close().catch((): undefined => undefined);
  }
}

/**
 * The skill folders in an agent's provider folder (#2929: "found on disk").
 * Read only and bounded: it lists folders, reads Clubhouse's manifest and the
 * start of each SKILL.md, and runs nothing. Finding a folder here never means
 * the provider loaded it.
 */
export async function listSkills(worktreePath: string, conv?: SettingsConventions): Promise<SkillEntry[]> {
  const c = conv || CLAUDE_CODE_CONVENTIONS;
  const skillsDir = path.join(worktreePath, skillsFolderOf(c));
  try {
    const entries = await fsp.readdir(skillsDir, { withFileTypes: true });
    const all = entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
    if (all.length > MAX_LISTED_SKILLS) appLog(LOG_NS, 'info', 'Skills list cut to its limit', { meta: { found: all.length, shown: MAX_LISTED_SKILLS } });
    const dirs = all.slice(0, MAX_LISTED_SKILLS);
    const managed = await managedSkillFolders(skillsDir);
    return Promise.all(dirs.map(async (e) => {
      const skillPath = path.join(skillsDir, e.name);
      const hasReadme = await pathExists(path.join(skillPath, 'README.md'));
      const skillName = await frontMatterName(skillPath);
      return { name: e.name, path: skillPath, hasReadme, ...(skillName && { skillName }), ...(managed.has(e.name) && { managed: true }) };
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

function assertStrictProjectSettings(value: unknown): asserts value is ProjectSettings {
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const text = (v: unknown) => typeof v === 'string' && v.length <= 65_536;
  const names = (v: unknown) => Array.isArray(v) && v.length <= 1000 && v.every((s) => typeof s === 'string' && s.length > 0 && s.length <= 1024);
  const invalid = () => { throw new Error('Project settings have an unsupported shape.'); };
  if (!record(value)) return invalid();
  for (const key of ['defaults', 'quickOverrides']) if (value[key] !== undefined && !record(value[key])) return invalid();
  if (value.defaultMcps !== undefined && !names(value.defaultMcps)) return invalid();
  if (value.launchWrapper !== undefined) {
    const w = value.launchWrapper;
    if (!record(w) || !text(w.binary) || !w.binary || !text(w.separator) || !record(w.orchestratorMap)) return invalid();
    if (Object.keys(w.orchestratorMap).length > 100 || !Object.values(w.orchestratorMap).every((m) => record(m) && text(m.subcommand))) return invalid();
    if (w.env !== undefined && (!record(w.env) || !Object.values(w.env).every(text))) return invalid();
    for (const key of ['refreshCommandId', 'contributingPluginId']) if (w[key] !== undefined && !text(w[key])) return invalid();
  }
  if (value.agentDefaults !== undefined) {
    const d = value.agentDefaults;
    if (!record(d)) return invalid();
    const strings = new Set(['instructions', 'mcpJson', 'buildCommand', 'testCommand', 'lintCommand', 'profileId', 'commandPrefix', 'mission', 'persona']);
    for (const [key, v] of Object.entries(d)) {
      if (strings.has(key) && text(v)) continue;
      if (key === 'freeAgentMode' && typeof v === 'boolean') continue;
      if (key === 'helperAuto' && v === 'off') continue;
      if (key === 'sourceControlProvider' && (v === 'github' || v === 'azure-devops')) continue;
      if (key === 'permissions' && record(v) && Object.entries(v).every(([k, list]) => ['allow', 'deny'].includes(k) && Array.isArray(list) && list.length <= 1000 && list.every(text))) continue;
      return invalid();
    }
  }
}

async function readSettings(projectPath: string, strict = false): Promise<ProjectSettings> {
  const settingsFile = path.join(projectPath, '.clubhouse', 'settings.json');
  const backupFile = `${settingsFile}.bak`;
  const emptySettings = { defaults: {}, quickOverrides: {} };

  try {
    const raw = JSON.parse(await fsp.readFile(settingsFile, 'utf-8'));
    if (strict) assertStrictProjectSettings(raw);
    if (!raw.defaults) raw.defaults = {};
    if (!raw.quickOverrides) raw.quickOverrides = {};
    return raw;
  } catch (err) {
    // Missing settings file is a normal condition — most projects won't have one.
    if (isEnoent(err)) {
      if (strict) {
        let backupExists = false;
        try { await fsp.stat(backupFile); backupExists = true; }
        catch (backupError) { if (!isEnoent(backupError)) throw new Error('Project settings are unreadable.'); }
        if (backupExists) throw new Error('Project settings need recovery before they can be displayed.');
      }
      return emptySettings;
    }
    if (strict) throw new Error('Project settings are unreadable.');

    appLog(LOG_NS, 'warn', `Failed to read project settings from ${settingsFile} — failed to parse; attempting recovery from backup`, {
      meta: { error: err instanceof Error ? err.message : String(err) },
    });

    try {
      const raw = JSON.parse(await fsp.readFile(backupFile, 'utf-8'));
      if (!raw.defaults) raw.defaults = {};
      if (!raw.quickOverrides) raw.quickOverrides = {};
      appLog(LOG_NS, 'warn', `Recovered project settings from backup ${backupFile}`);
      return raw;
    } catch (backupErr) {
      if (!isEnoent(backupErr)) {
        appLog(LOG_NS, 'error', `Failed to parse project settings backup from ${backupFile}`, {
          meta: { error: backupErr instanceof Error ? backupErr.message : String(backupErr) },
        });
      }
    }

    return emptySettings;
  }
}

/** One queue and mutation witness for symlink/case aliases of a project. */
function projectSettingsKey(projectPath: string): string {
  let resolved: string;
  try {
    resolved = realpathSync(projectPath);
  } catch {
    // telemetry-exempt: a not-yet-created project still needs a stable queue key.
    resolved = path.resolve(projectPath);
  }
  try {
    const stats = statSync(resolved, { bigint: true });
    if (stats.ino) return `directory:${stats.dev}:${stats.ino}`;
  } catch {
    // telemetry-exempt: absent directories fall back to the resolved spelling.
  }
  return resolved;
}

// Read-only launch witnesses, including a write already pending at capture time.
const settingsMutations = new Map<string, { generation: number; pending: number }>();
export function projectSettingsMutationState(projectPath: string): { generation: number; pending: boolean } {
  const state = settingsMutations.get(projectSettingsKey(projectPath));
  return { generation: state?.generation ?? 0, pending: (state?.pending ?? 0) > 0 };
}
async function settingsMutation<T>(projectPath: string, run: () => Promise<T>): Promise<T> {
  const key = projectSettingsKey(projectPath);
  const state = settingsMutations.get(key) ?? { generation: 0, pending: 0 };
  settingsMutations.set(key, state); state.generation++; state.pending++;
  try { return await run(); } finally { state.pending--; }
}

// Every read-modify-write shares this queue, including source-folder discovery.
const settingsWrites = new Map<string, Promise<void>>();
function updateSettings<T>(projectPath: string, update: (settings: ProjectSettings) => T | Promise<T>): Promise<T> {
  const key = projectSettingsKey(projectPath);
  return settingsMutation(projectPath, () => {
    const previous = settingsWrites.get(key);
    const run = async () => {
      const settings = await readSettings(projectPath);
      const value = await update(settings);
      // null means the caller found nothing to change.
      if (value !== null) await writeSettings(projectPath, settings);
      return value;
    };
    const result = previous ? previous.then(run) : run();
    const settled = result.then((): void => undefined, (): void => undefined);
    settingsWrites.set(key, settled);
    void settled.then(() => { if (settingsWrites.get(key) === settled) settingsWrites.delete(key); });
    return result;
  });
}

async function writeSettings(projectPath: string, settings: ProjectSettings): Promise<void> {
  const dir = path.join(projectPath, '.clubhouse');
  const file = path.join(dir, 'settings.json');
  await fsp.mkdir(dir, { recursive: true });
  let readable = false;
  let unreadable = false;
  try {
    const previous: unknown = JSON.parse(await fsp.readFile(file, 'utf-8'));
    readable = previous !== null && typeof previous === 'object' && !Array.isArray(previous);
    unreadable = !readable;
  } catch (err) {
    // telemetry-exempt: never replace a recoverable backup with unreadable live bytes.
    unreadable = !isEnoent(err);
  }
  // The backup and recovery copies below must not be committable by `git add -A` (#3623).
  if (readable || unreadable) await ensureLocalExcludesOnce(projectPath);
  if (readable) await fsp.copyFile(file, `${file}.bak`);
  else if (unreadable) backupUnreadableFile(file);
  await replaceFile(file, JSON.stringify(settings, null, 2), undefined);
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
 * List source mission files under .clubhouse/missions/.
 * Each mission is a single .md file; the mission ID is the basename without extension.
 */
export async function listSourceMissions(projectPath: string): Promise<Array<{ id: string; path: string }>> {
  const missionsDir = path.join(projectPath, '.clubhouse', 'missions');
  try {
    const entries = await fsp.readdir(missionsDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => ({ id: e.name.replace(/\.md$/, ''), path: path.join(missionsDir, e.name) }));
  } catch (err) {
    if (!isEnoent(err)) {
      appLog(LOG_NS, 'warn', `Failed to list missions from ${missionsDir}`, { meta: { error: err instanceof Error ? err.message : String(err) } });
    }
    return [];
  }
}

/**
 * Read the content of a mission file at .clubhouse/missions/<id>.md.
 * Returns empty string when the mission file does not exist or fails to read.
 */
export async function readSourceMissionContent(projectPath: string, missionId: string): Promise<string> {
  if (!missionId) return '';
  const filePath = path.join(projectPath, '.clubhouse', 'missions', `${missionId}.md`);
  try {
    return await fsp.readFile(filePath, 'utf-8');
  } catch (err) {
    if (!isEnoent(err)) {
      appLog(LOG_NS, 'warn', `Failed to read mission "${missionId}" at ${filePath}`, { meta: { error: err instanceof Error ? err.message : String(err) } });
    }
    return '';
  }
}

/**
 * Write the content of a mission file at .clubhouse/missions/<id>.md, creating
 * the directory if needed.
 */
export async function writeSourceMissionContent(projectPath: string, missionId: string, content: string): Promise<void> {
  const dir = path.join(projectPath, '.clubhouse', 'missions');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, `${missionId}.md`), content, 'utf-8');
}

/**
 * Delete a mission file at .clubhouse/missions/<id>.md. No-op if missing.
 */
export async function deleteSourceMission(projectPath: string, missionId: string): Promise<void> {
  const filePath = path.join(projectPath, '.clubhouse', 'missions', `${missionId}.md`);
  await fsp.rm(filePath, { force: true });
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
    : path.join(basePath, skillsFolderOf(c), name);
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
      await updateSettings(projectPath, (settings): void | null => {
        if (settings.defaultSkillsPath) return null;
        settings.defaultSkillsPath = path.relative(path.join(projectPath, '.clubhouse'), basePath);
      });
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
      await updateSettings(projectPath, (settings): void | null => {
        if (settings.defaultAgentsPath) return null;
        settings.defaultAgentsPath = path.relative(path.join(projectPath, '.clubhouse'), basePath);
      });
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
  if (c.permissionRules === false) return {};
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
    if (!isEnoent(err)) {
      appLog(LOG_NS, 'warn', `Failed to read permissions from ${settingsPath}`, { meta: { error: err instanceof Error ? err.message : String(err) } });
    }
    return {};
  }
}

/**
 * Read the content of a skill's SKILL.md file.
 * Uses conventions to resolve the correct config directory.
 */
export async function readSkillContent(worktreePath: string, skillName: string, conv?: SettingsConventions): Promise<string> {
  const c = conv || CLAUDE_CODE_CONVENTIONS;
  const filePath = path.join(worktreePath, skillsFolderOf(c), skillName, 'SKILL.md');
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
  const dir = path.join(worktreePath, skillsFolderOf(c), skillName);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'SKILL.md'), content, 'utf-8');
}

/**
 * Delete a skill directory and all its contents.
 */
export async function deleteSkill(worktreePath: string, skillName: string, conv?: SettingsConventions): Promise<void> {
  const c = conv || CLAUDE_CODE_CONVENTIONS;
  const dir = path.join(worktreePath, skillsFolderOf(c), skillName);
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

/** Missing and intentionally empty are different. Never hide read errors or non-JSON files. */
export async function readLocalMcpJson(worktreePath: string, conv?: SettingsConventions): Promise<string | null> {
  const c = conv || CLAUDE_CODE_CONVENTIONS;
  let raw: string;
  try { raw = await fsp.readFile(path.join(worktreePath, c.mcpConfigFile), 'utf-8'); } catch (err) {
    if (isEnoent(err)) return null;
    throw new Error('Could not read local MCP configuration. Check file access before starting.');
  }
  if (c.settingsFormat && c.settingsFormat !== 'json') {
    throw new Error('Local MCP configuration uses an unsupported non-JSON format. This editor and chat preparation cannot read it; the file was preserved.');
  }
  return raw;
}

/**
 * Read the raw MCP config file content as a string.
 * Uses conventions to resolve the correct MCP config file path.
 */
export async function readMcpRawJson(worktreePath: string, conv?: SettingsConventions): Promise<string> {
  const c = conv || CLAUDE_CODE_CONVENTIONS;
  if (c.settingsFormat && c.settingsFormat !== 'json') {
    throw new Error('The MCP JSON editor does not support this provider’s non-JSON settings format. The file was preserved.');
  }
  const warning = await getMcpShadowWarning(worktreePath, c);
  if (warning) appLog(LOG_NS, 'warn', warning, { meta: { worktreePath, mcpConfigFile: c.mcpConfigFile } });
  return await readLocalMcpJson(worktreePath, c) ?? '{\n  "mcpServers": {}\n}';
}

/**
 * Write raw JSON string to MCP config file. Validates JSON before writing.
 * Returns { ok: true } on success, or { ok: false, error: string } on parse failure.
 */
export async function writeMcpRawJson(worktreePath: string, content: string, conv?: SettingsConventions, beforeWrite?: () => Promise<void>): Promise<{ ok: boolean; error?: string }> {
  const c = conv || CLAUDE_CODE_CONVENTIONS;
  // Non-JSON config files (e.g. TOML) — refuse to write JSON content
  if (c.settingsFormat && c.settingsFormat !== 'json') {
    return { ok: false, error: 'MCP config writes are not supported for non-JSON settings formats' };
  }
  try {
    parseMcpJson(content); // Validate shape and transport before touching the file
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Invalid JSON' };
  }

  const shadowWarning = await getMcpShadowWarning(worktreePath, c);
  if (shadowWarning) {
    appLog(LOG_NS, 'warn', shadowWarning, { meta: { worktreePath, mcpConfigFile: c.mcpConfigFile } });
  }

  const filePath = path.join(worktreePath, c.mcpConfigFile);
  // Ensure parent directory exists (e.g. .github/ for copilot)
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  await beforeWrite?.();
  await fsp.writeFile(filePath, content, 'utf-8');
  return { ok: true };
}

/**
 * Write permissions to .claude/settings.local.json in the given worktree.
 * Merges with existing file content (preserves hooks and other settings).
 */
export function assertPermissionRulesSupported(permissions: PermissionsConfig, conv?: SettingsConventions): void {
  if (conv?.permissionRules === false && (permissions.allow?.length || permissions.deny?.length)) {
    throw new UnsupportedPermissionRulesError('Copilot does not support Clubhouse allow/deny permission rules. Remove these project defaults or configure access using Copilot settings. No permission rules were applied.');
  }
}

export async function writePermissions(worktreePath: string, permissions: PermissionsConfig, conv?: SettingsConventions): Promise<void> {
  const c = conv || CLAUDE_CODE_CONVENTIONS;
  assertPermissionRulesSupported(permissions, c);
  if (c.permissionRules === false) return;
  // Non-JSON settings files (e.g. TOML) are not supported — skip write
  if (c.settingsFormat && c.settingsFormat !== 'json') return;
  const settingsPath = path.join(worktreePath, c.configDir, c.localSettingsFile);
  const settingsDir = path.dirname(settingsPath);
  await fsp.mkdir(settingsDir, { recursive: true });

  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await fsp.readFile(settingsPath, 'utf-8'));
  } catch (err) {
    if (!isEnoent(err)) {
      appLog(LOG_NS, 'warn', `Failed to read existing settings at ${settingsPath}, starting fresh`, { meta: { error: err instanceof Error ? err.message : String(err) } });
    }
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
export async function readProjectAgentDefaults(projectPath: string, options: { strict?: boolean } = {}): Promise<ProjectAgentDefaults> {
  const settings = await readSettings(projectPath, options.strict);
  return settings.agentDefaults || {};
}

/**
 * What the audit keeps of a project's defaults (#2671). A key missing here doesn't
 * compile, so a new one is a decision. Most can hold commands, env or text.
 */
const PROJECT_DEFAULTS_AUDIT_CATALOG: Readonly<Record<keyof ProjectAgentDefaults, AuditKeyFormat>> = {
  freeAgentMode: 'value',
  sourceControlProvider: 'value',
  profileId: 'value',
  persona: 'value',
  mission: 'value',
  helperAuto: 'value',
  instructions: 'changed',
  permissions: 'changed',
  mcpJson: 'changed',
  buildCommand: 'changed',
  testCommand: 'changed',
  lintCommand: 'changed',
  commandPrefix: 'changed',
} as Readonly<Record<keyof ProjectAgentDefaults, AuditKeyFormat>>;

/**
 * Write project-level agent defaults to .clubhouse/settings.json.
 */
export async function writeProjectAgentDefaults(projectPath: string, defaults: ProjectAgentDefaults): Promise<void> {
  await updateProjectAgentDefaults(projectPath, () => defaults);
}

/** Change project defaults within the same queue as every other settings writer. */
export async function updateProjectAgentDefaults(
  projectPath: string,
  update: (current: ProjectAgentDefaults) => ProjectAgentDefaults | null,
): Promise<ProjectAgentDefaults | null> {
  let previous: ProjectAgentDefaults = {};
  const next = await updateSettings(projectPath, (settings) => {
    previous = settings.agentDefaults ?? {};
    const defaults = update(previous);
    if (!defaults) return null;
    if (defaults.commandPrefix) validateCommandPrefix(defaults.commandPrefix);
    settings.agentDefaults = defaults;
    return defaults;
  });
  if (next) {
    await auditChanges('project', 'project.defaults', projectAuditTarget(projectPath), previous as Record<string, unknown>, next as Record<string, unknown>, PROJECT_DEFAULTS_AUDIT_CATALOG);
    if (next.helperAuto !== previous.helperAuto) noteRoutingPolicyChanged();
  }
  return next;
}

function jsonEscapedWildcards(ctx: WildcardContext): WildcardContext {
  const esc = (v: string | undefined) => (v === undefined ? undefined : JSON.stringify(v).slice(1, -1));
  return {
    agentName: esc(ctx.agentName)!, standbyBranch: esc(ctx.standbyBranch)!, agentPath: esc(ctx.agentPath)!,
    sourceControlProvider: esc(ctx.sourceControlProvider),
    buildCommand: esc(ctx.buildCommand ?? 'npm run build'), testCommand: esc(ctx.testCommand ?? 'npm test'), lintCommand: esc(ctx.lintCommand ?? 'npm run lint'),
  };
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
 * @param wildcards     - The new agent's `@@` values, filled into the instructions,
 *                        permission rules and MCP JSON before they're written (#2439)
 */
export async function applyAgentDefaults(
  worktreePath: string,
  projectPath: string,
  writeInstructions?: (worktreePath: string, content: string) => void | Promise<void>,
  conv?: SettingsConventions,
  wildcards?: WildcardContext,
): Promise<void> {
  const c = conv || CLAUDE_CODE_CONVENTIONS;
  const raw = await readProjectAgentDefaults(projectPath);
  if (!raw) return;
  const fill = (text: string) => (wildcards ? replaceWildcards(text, wildcards) : text);
  // Inside JSON a filled value is escaped, so a quote or backslash in a name or command can't break it.
  const fillJson = (json: string) => (wildcards ? replaceWildcards(json, jsonEscapedWildcards(wildcards)) : json);
  const defaults = {
    ...raw,
    ...(raw.instructions && { instructions: fill(raw.instructions) }),
    ...(raw.mcpJson && { mcpJson: fillJson(raw.mcpJson) }),
    ...(raw.permissions && {
      permissions: {
        ...(raw.permissions.allow && { allow: raw.permissions.allow.map(fill) }),
        ...(raw.permissions.deny && { deny: raw.permissions.deny.map(fill) }),
      },
    }),
  };

  if (defaults.permissions) assertPermissionRulesSupported(defaults.permissions, c);

  if (defaults.instructions) {
    if (writeInstructions) {
      await writeInstructions(worktreePath, defaults.instructions);
    } else {
      await writeClaudeMd(worktreePath, defaults.instructions);
    }
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
  if (defaults.permissions) {
    await writePermissions(worktreePath, defaults.permissions, conv);
  }

}

/**
 * Read the launch wrapper config from .clubhouse/settings.json.
 * Returns undefined when no wrapper is configured.
 */
export async function readLaunchWrapper(projectPath: string, options: { strict?: boolean } = {}): Promise<LaunchWrapperConfig | undefined> {
  const settings = await readSettings(projectPath, options.strict);
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
export async function readDefaultMcps(projectPath: string, options: { strict?: boolean } = {}): Promise<string[]> {
  const settings = await readSettings(projectPath, options.strict);
  return settings.defaultMcps || [];
}

/**
 * Write the launch wrapper config to .clubhouse/settings.json.
 * Pass undefined to remove the wrapper.
 */
export async function writeLaunchWrapper(projectPath: string, wrapper: LaunchWrapperConfig | undefined): Promise<void> {
  await updateSettings(projectPath, (settings) => {
    if (wrapper) {
      settings.launchWrapper = wrapper;
    } else {
      delete settings.launchWrapper;
    }
  });
}

/**
 * Write the MCP catalog to .clubhouse/settings.json.
 */
export async function writeMcpCatalog(projectPath: string, catalog: McpCatalogEntry[]): Promise<void> {
  await updateSettings(projectPath, (settings) => {
    settings.mcpCatalog = catalog;
  });
}

/**
 * Write project default MCP IDs to .clubhouse/settings.json.
 */
export async function writeDefaultMcps(projectPath: string, mcpIds: string[]): Promise<void> {
  await updateSettings(projectPath, (settings) => {
    settings.defaultMcps = mcpIds;
  });
}

/**
 * Read the last-acknowledged wrapper catalog snapshot from .clubhouse/settings.json.
 * Returns undefined when no snapshot has been recorded.
 */
export async function readWrapperCatalogSnapshot(projectPath: string): Promise<WrapperCatalogSnapshot | undefined> {
  const settings = await readSettings(projectPath);
  return settings.wrapperCatalogSnapshot;
}

/**
 * Write the wrapper catalog snapshot to .clubhouse/settings.json.
 * Pass undefined to remove the snapshot.
 */
export async function writeWrapperCatalogSnapshot(projectPath: string, snapshot: WrapperCatalogSnapshot | undefined): Promise<void> {
  await updateSettings(projectPath, (settings) => {
    if (snapshot) {
      settings.wrapperCatalogSnapshot = snapshot;
    } else {
      delete settings.wrapperCatalogSnapshot;
    }
  });
}

export async function readMcpConfigs(projectPath: string): Promise<Record<string, Record<string, string>>> {
  const settings = await readSettings(projectPath);
  return settings.mcpConfigs || {};
}

export async function writeMcpConfigs(projectPath: string, configs: Record<string, Record<string, string>>): Promise<void> {
  await updateSettings(projectPath, (settings) => {
    if (Object.keys(configs).length > 0) {
      settings.mcpConfigs = configs;
    } else {
      delete settings.mcpConfigs;
    }
  });
}
