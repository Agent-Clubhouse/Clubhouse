/**
 * The read-only inventory step of existing-user import (#2820): what the
 * registered projects hold that could become library entries. It offers,
 * imports and writes nothing, and nothing calls it yet but tests.
 *
 * Reads only, which rules out most of the app's usual readers:
 *   - projects and agents come from peekProjects and peekDurableConfigs, since
 *     list() and listDurable() can migrate, restore and start watchers;
 *   - project settings are parsed here, since readProjectAgentDefaults logs parse
 *     errors, and a JSON parse error can quote the file;
 *   - git state comes from git-state.ts, which never refreshes the index.
 *
 * Results hold names, paths and hashes. File contents stay in this module, for
 * hashing and secret checks, and logs get counts.
 */
import { createHash } from 'crypto';
import type { Dirent, Stats } from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { peekDurableConfigs } from '../agent-config';
import { getBaseDirPath } from '../base-dir';
import { appLog } from '../log-service';
import { getDefaultAgentTemplates } from '../materialization-service';
import {
  BUILD_SKILL_CONTENT,
  CREATE_PR_SKILL_CONTENT,
  GO_STANDBY_SKILL_CONTENT,
  LINT_SKILL_CONTENT,
  MISSION_SKILL_CONTENT,
  TEST_SKILL_CONTENT,
  VALIDATE_CHANGES_SKILL_CONTENT,
} from '../materialization-service-content';
import { peekProjects } from '../project-store';
import { peekStoredSettings } from '../settings-store';
import { HIDDEN_PERSONA_TEMPLATES, PERSONA_TEMPLATES } from '../../../renderer/features/personas';
import { parsePersonaFile } from '../../../shared/persona-pattern';
import type { DurableAgentConfig, ProjectAgentDefaults } from '../../../shared/types';
import type {
  ImportInventory,
  InventoryAgentReport,
  InventoryBuiltinMatch,
  InventoryClubhouseMode,
  InventoryEntry,
  InventoryExclusionCounts,
  InventoryExclusionReason,
  InventoryFile,
  InventoryKind,
  InventoryMcpDefinition,
  InventoryOrphanedConfig,
  InventoryPersonaMetadata,
  InventoryProgress,
  InventoryProjectReport,
  InventoryScope,
  InventorySource,
  InventorySourceCaveat,
} from '../../../shared/import-inventory-types';
import {
  NON_DEFINITION_DIRS,
  hasDefinitionExtension,
  hasSecretLookingContent,
  isSecretLookingName,
  looksBinary,
} from './classify';
import { readGitStates, toGitPath } from './git-state';
import { parseJsonMcpServers, parseTomlMcpServers, readMcpEntry } from './mcp-definitions';

const LOG_NS = 'core:import-inventory';
const CLUBHOUSE_MODE_SETTINGS_FILE = 'clubhouse-mode-settings.json';
/** The other settings files with `projectOverrides` keyed by project path. Read only to report orphans. */
const OTHER_OVERRIDE_SETTINGS_FILES: readonly string[] = ['mcp-settings.json', 'session-settings.json', 'free-agent-settings.json', 'headless-settings.json'];

/** Every provider's instructions file; import-inventory.test.ts checks this against the providers. */
export const INSTRUCTION_FILES: readonly string[] = ['CLAUDE.md', 'AGENTS.md', '.github/copilot-instructions.md'];

/** Project-level MCP config files: each provider's `conventions.mcpConfigFile`. */
export const PROJECT_MCP_FILES: ReadonlyArray<{ file: string; format: 'json' | 'toml' }> = [
  { file: '.mcp.json', format: 'json' },
  { file: '.github/mcp.json', format: 'json' },
  { file: '.codex/config.toml', format: 'toml' },
];

const PROVIDER_CONFIG_DIRS: readonly string[] = ['.claude', '.codex', '.github'];

/** Each CLI's user-level config at its default location. */
const GLOBAL_SOURCES: ReadonlyArray<{
  dir: string;
  instructions?: string;
  mcp?: { file: string; format: 'json' | 'toml' };
}> = [
  { dir: '.claude', instructions: 'CLAUDE.md', mcp: { file: '.claude.json', format: 'json' } },
  { dir: '.codex', instructions: 'AGENTS.md', mcp: { file: '.codex/config.toml', format: 'toml' } },
  { dir: '.copilot', instructions: 'copilot-instructions.md', mcp: { file: '.copilot/mcp-config.json', format: 'json' } },
];

export interface InventoryLimits {
  /** Directory entries looked at per project, counted or not. */
  maxFilesPerProject: number;
  maxFileBytes: number;
  /** Larger for config files, where only the MCP section is kept. */
  maxConfigFileBytes: number;
  maxBytesPerProject: number;
  maxDepth: number;
}

export const DEFAULT_INVENTORY_LIMITS: InventoryLimits = {
  maxFilesPerProject: 5000,
  maxFileBytes: 1024 * 1024,
  maxConfigFileBytes: 8 * 1024 * 1024,
  maxBytesPerProject: 64 * 1024 * 1024,
  maxDepth: 12,
};

/** The filesystem calls a scan makes. A test swaps them to stand in for a hung network drive. */
export interface InventoryFs {
  stat(p: string): Promise<Stats>;
  lstat(p: string): Promise<Stats>;
  readdir(p: string): Promise<Dirent[]>;
  readFile(p: string): Promise<Buffer>;
}

const REAL_FS: InventoryFs = {
  stat: (p) => fsp.stat(p),
  lstat: (p) => fsp.lstat(p),
  readdir: (p) => fsp.readdir(p, { withFileTypes: true }),
  readFile: (p) => fsp.readFile(p),
};

export interface InventoryOptions {
  /** Selectable scope: these project ids, or all when omitted. Orphans are still judged against all. */
  projectIds?: readonly string[];
  /** Also read provider folders in project roots and user-level config. Off by default. */
  includeProviderConfig?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: InventoryProgress) => void;
  limits?: Partial<InventoryLimits>;
  /** How long one project may take. A hung mount is reported as unavailable and the scan moves on. */
  projectTimeoutMs?: number;
  homeDir?: string;
  fs?: InventoryFs;
}

const DEFAULT_PROJECT_TIMEOUT_MS = 60_000;

class ScanStopped extends Error {}

function emptyExclusions(): InventoryExclusionCounts {
  return { 'secret-looking': 0, 'non-definition': 0, 'too-large': 0, unreadable: 0, symlink: 0, 'over-limit': 0 };
}

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** So a checkout with CRLF endings still matches what ships. For built-in matching only. */
function builtinHash(text: string): string {
  return sha256(text.replace(/\r\n/g, '\n'));
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function wildcardsIn(text: string): string[] {
  return [...new Set(text.match(/@@[A-Za-z]+/g) ?? [])].sort();
}

/**
 * A path as a comparison key: separators, `.` segments and trailing separators
 * don't count, nor does case on Windows. Only for telling whether a stored key
 * names a project; isClubhouseModeEnabled itself matches the exact string.
 */
export function projectPathKey(p: string, platform: NodeJS.Platform = process.platform): string {
  const impl = platform === 'win32' ? path.win32 : path.posix;
  let normal = impl.normalize(p);
  while (normal.length > impl.parse(normal).root.length && normal.endsWith(impl.sep)) normal = normal.slice(0, -1);
  return platform === 'win32' ? normal.toLowerCase() : normal;
}

/**
 * A source folder `sub` under `.clubhouse` (`base`), or null when a stored value
 * would land outside it, as `../..` would, or on `.clubhouse` itself or its
 * `agents` folder, which hold generated worktrees.
 */
export function confinedJoin(base: string, sub: string, impl: path.PlatformPath = path): string | null {
  const joined = impl.join(base, sub);
  const rel = impl.relative(base, joined);
  if (rel === '' || rel === '..' || rel.startsWith(`..${impl.sep}`) || impl.isAbsolute(rel)) return null;
  return rel.split(impl.sep)[0] === 'agents' ? null : joined;
}

// ── Built-ins ────────────────────────────────────────────────────────────

interface BuiltinTables {
  skills: Map<string, string>;
  personas: Map<string, string>;
  instructions: string;
  permissions: string;
}

let builtinTables: BuiltinTables | null = null;

function builtins(): BuiltinTables {
  if (builtinTables) return builtinTables;
  const skills: Array<[string, string]> = [
    ['mission', MISSION_SKILL_CONTENT],
    ['create-pr', CREATE_PR_SKILL_CONTENT],
    ['go-standby', GO_STANDBY_SKILL_CONTENT],
    ['build', BUILD_SKILL_CONTENT],
    ['test', TEST_SKILL_CONTENT],
    ['lint', LINT_SKILL_CONTENT],
    ['validate-changes', VALIDATE_CHANGES_SKILL_CONTENT],
  ];
  const defaults = getDefaultAgentTemplates();
  builtinTables = {
    skills: new Map(skills.map(([id, content]) => [builtinHash(content), id])),
    personas: new Map([...PERSONA_TEMPLATES, ...HIDDEN_PERSONA_TEMPLATES].map((p) => [builtinHash(p.content), p.id])),
    instructions: builtinHash(defaults.instructions ?? ''),
    permissions: canonical(defaults.permissions),
  };
  return builtinTables;
}

// ── One scan's working state ─────────────────────────────────────────────

interface ScannedFile {
  path: string;
  relativePath: string;
  root: string;
  contentHash: string;
  normalizedHash: string;
  sizeBytes: number;
  wildcards: string[];
  text: string;
}

/** An item before git state and merging. */
interface RawItem {
  kind: InventoryKind;
  name: string;
  scope: InventoryScope;
  contentHash: string;
  wildcards: string[];
  root: string;
  path: string;
  pointer?: string;
  agent?: { id: string; name: string };
  files: ScannedFile[];
  excludedFileCount: number;
  builtinId?: string;
  mcp?: InventoryMcpDefinition;
  persona?: InventoryPersonaMetadata;
  caveats?: InventorySourceCaveat[];
}

interface Context {
  fs: InventoryFs;
  limits: InventoryLimits;
  signal: AbortSignal;
  excluded: InventoryExclusionCounts;
  filesSeen: number;
  bytesRead: number;
  truncated: boolean;
  bridgeFiltered: number;
  warnings: Set<string>;
  onFiles?: (filesSeen: number) => void;
}

function newContext(
  fs: InventoryFs,
  limits: InventoryLimits,
  signal: AbortSignal,
  onFiles?: (filesSeen: number) => void,
): Context {
  return {
    fs, limits, signal, onFiles,
    excluded: emptyExclusions(),
    filesSeen: 0,
    bytesRead: 0,
    truncated: false,
    bridgeFiltered: 0,
    warnings: new Set(),
  };
}

/** Lets the main process breathe and honors a cancel. Called once per directory entry. */
async function checkpoint(ctx: Context): Promise<void> {
  if (ctx.signal.aborted) throw new ScanStopped();
  if (ctx.filesSeen % 25 === 0) {
    ctx.onFiles?.(ctx.filesSeen);
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (ctx.signal.aborted) throw new ScanStopped();
  }
}

function errorCode(err: unknown): string {
  return (err as NodeJS.ErrnoException)?.code ?? 'error';
}

function isMissing(err: unknown): boolean {
  const code = errorCode(err);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** One more directory entry against the project's bound; false once it's spent. */
function countEntry(ctx: Context): boolean {
  if (ctx.filesSeen >= ctx.limits.maxFilesPerProject) {
    ctx.truncated = true;
    ctx.excluded['over-limit']++;
    return false;
  }
  ctx.filesSeen++;
  return true;
}

type ReadOutcome = { file: ScannedFile } | 'excluded' | 'missing';

/**
 * A candidate definition file, or a count of why it isn't one. The `lstat` makes
 * it safe to call on a guessed path: a symlink or a FIFO is never opened.
 */
async function readDefinitionFile(
  ctx: Context,
  root: string,
  file: string,
  opts: { maxBytes?: number; allowAnyExtension?: boolean; skipContentCheck?: boolean } = {},
): Promise<ReadOutcome> {
  await checkpoint(ctx);
  const name = path.basename(file);
  let stats: Stats;
  try {
    stats = await ctx.fs.lstat(file);
  } catch (err) {
    // telemetry-exempt: counted; one unreadable file must not stop the project
    if (isMissing(err)) return 'missing';
    ctx.excluded.unreadable++;
    return 'excluded';
  }
  if (!countEntry(ctx)) return 'excluded';
  const fail = (reason: InventoryExclusionReason): ReadOutcome => {
    ctx.excluded[reason]++;
    return 'excluded';
  };
  if (stats.isSymbolicLink()) return fail('symlink');
  if (!stats.isFile()) return fail('non-definition');
  if (isSecretLookingName(name)) return fail('secret-looking');
  if (!opts.allowAnyExtension && !hasDefinitionExtension(name)) return fail('non-definition');
  if (stats.size > (opts.maxBytes ?? ctx.limits.maxFileBytes)) return fail('too-large');
  if (ctx.bytesRead + stats.size > ctx.limits.maxBytesPerProject) {
    ctx.truncated = true;
    return fail('over-limit');
  }

  let bytes: Buffer;
  try {
    bytes = await ctx.fs.readFile(file);
  } catch (err) {
    // telemetry-exempt: counted; one unreadable file must not stop the project
    if (isMissing(err)) return 'missing';
    return fail('unreadable');
  }
  ctx.bytesRead += bytes.length;
  if (looksBinary(bytes)) return fail('non-definition');
  const text = bytes.toString('utf-8');
  if (!opts.skipContentCheck && hasSecretLookingContent(text)) return fail('secret-looking');
  return {
    file: {
      path: file,
      relativePath: toGitPath(root, file),
      root,
      contentHash: sha256(bytes),
      normalizedHash: builtinHash(text),
      sizeBytes: bytes.length,
      wildcards: wildcardsIn(text),
      text,
    },
  };
}

/** Every definition under `dir`. Returns the files and how many were left out. */
async function walkDefinitionFiles(ctx: Context, root: string, dir: string): Promise<{ files: ScannedFile[]; excluded: number; overLimit: boolean }> {
  const files: ScannedFile[] = [];
  let excluded = 0;
  let overLimit = false;

  const visit = async (current: string, depth: number): Promise<void> => {
    let dirents: Dirent[];
    try {
      dirents = await ctx.fs.readdir(current);
    } catch (err) {
      // telemetry-exempt: counted; one unreadable folder must not stop the project
      if (!isMissing(err)) ctx.excluded.unreadable++;
      excluded++;
      return;
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const dirent of dirents) {
      const full = path.join(current, dirent.name);
      if (dirent.isDirectory()) {
        await checkpoint(ctx);
        if (!countEntry(ctx)) {
          overLimit = true;
          return;
        }
        if (NON_DEFINITION_DIRS.has(dirent.name) || depth >= ctx.limits.maxDepth) {
          ctx.excluded['non-definition']++;
          excluded++;
        } else if (isSecretLookingName(dirent.name)) {
          ctx.excluded['secret-looking']++;
          excluded++;
        } else {
          await visit(full, depth + 1);
          if (overLimit) return;
        }
        continue;
      }
      const outcome = await readDefinitionFile(ctx, root, full);
      if (outcome === 'excluded') {
        excluded++;
        if (ctx.truncated) {
          overLimit = true;
          return;
        }
      } else if (outcome !== 'missing') {
        files.push(outcome.file);
      }
    }
  };

  await visit(dir, 0);
  return { files, excluded, overLimit };
}

/** A folder's hash: each file's path and hash, so a rename changes it too. */
function folderHash(files: readonly ScannedFile[], base: string): string {
  const lines = files.map((f) => `${toGitPath(base, f.path)}\0${f.contentHash}`).sort();
  return sha256(lines.join('\n'));
}

// ── Sources ──────────────────────────────────────────────────────────────

/** Named folders under `dir`: skills and agent templates. A loose file is what the code ignores, so it's counted. */
async function scanFolderItems(
  ctx: Context,
  root: string,
  dir: string,
  kind: 'skill' | 'agent-template',
  scope: InventoryScope,
): Promise<RawItem[]> {
  let dirents: Dirent[];
  try {
    dirents = await ctx.fs.readdir(dir);
  } catch (err) {
    // telemetry-exempt: a project without this folder is the common case; anything else is counted
    if (!isMissing(err)) ctx.excluded.unreadable++;
    return [];
  }
  dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const items: RawItem[] = [];
  for (const dirent of dirents) {
    await checkpoint(ctx);
    if (!dirent.isDirectory()) {
      if (!countEntry(ctx)) break;
      ctx.excluded[dirent.isSymbolicLink() ? 'symlink' : 'non-definition']++;
      continue;
    }
    if (!countEntry(ctx)) break;
    const folder = path.join(dir, dirent.name);
    const { files, excluded, overLimit } = await walkDefinitionFiles(ctx, root, folder);
    // A folder cut short by the bound would read as a complete, different item.
    if (overLimit) break;
    if (files.length === 0) continue;
    const item: RawItem = {
      kind, name: dirent.name, scope, root, path: folder, files,
      contentHash: folderHash(files, folder),
      wildcards: [...new Set(files.flatMap((f) => f.wildcards))].sort(),
      excludedFileCount: excluded,
    };
    if (kind === 'skill' && files.length === 1 && excluded === 0 && path.basename(files[0].path) === 'SKILL.md') {
      item.builtinId = builtins().skills.get(files[0].normalizedHash);
    }
    items.push(item);
  }
  return items;
}

function singleFileItem(kind: InventoryKind, name: string, scope: InventoryScope, file: ScannedFile): RawItem {
  return {
    kind, name, scope,
    root: file.root,
    path: file.path,
    files: [file],
    contentHash: file.contentHash,
    wildcards: file.wildcards,
    excludedFileCount: 0,
  };
}

function personaMetadata(text: string): InventoryPersonaMetadata {
  const { settings } = parsePersonaFile(text);
  const skills = Array.isArray(settings.skills) ? settings.skills : [];
  return {
    frontMatterKeys: Object.keys(settings).sort(),
    inertSkillDeclarations: skills.map((s) => (typeof s?.name === 'string' ? s.name : '')).filter(Boolean),
  };
}

async function scanPersonaFolder(ctx: Context, root: string, dir: string, scope: InventoryScope): Promise<RawItem[]> {
  let dirents: Dirent[];
  try {
    dirents = await ctx.fs.readdir(dir);
  } catch (err) {
    // telemetry-exempt: a project without this folder is the common case; anything else is counted
    if (!isMissing(err)) ctx.excluded.unreadable++;
    return [];
  }
  dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const items: RawItem[] = [];
  for (const dirent of dirents) {
    if (!dirent.name.endsWith('.md')) {
      await checkpoint(ctx);
      if (!countEntry(ctx)) break;
      ctx.excluded['non-definition']++;
      continue;
    }
    const outcome = await readDefinitionFile(ctx, root, path.join(dir, dirent.name));
    if (outcome === 'excluded' || outcome === 'missing') continue;
    const item = singleFileItem('persona', dirent.name.slice(0, -'.md'.length), scope, outcome.file);
    item.persona = personaMetadata(outcome.file.text);
    item.builtinId = builtins().personas.get(outcome.file.normalizedHash);
    items.push(item);
  }
  return items;
}

/** MCP servers in one text, as items. Env values are gone by the time the hash is taken. */
function mcpItems(
  ctx: Context,
  servers: Record<string, unknown>,
  scope: InventoryScope,
  file: ScannedFile,
  pointer: (name: string) => string | undefined,
): RawItem[] {
  const items: RawItem[] = [];
  for (const [name, entry] of Object.entries(servers)) {
    const result = readMcpEntry(entry);
    if (result.kind === 'bridge') {
      ctx.bridgeFiltered++;
    } else if (result.kind === 'secret') {
      ctx.excluded['secret-looking']++;
    } else if (result.kind === 'invalid') {
      ctx.excluded['non-definition']++;
    } else {
      items.push({
        kind: 'mcp-server', name, scope,
        root: file.root,
        path: file.path,
        pointer: pointer(name),
        files: [file],
        contentHash: sha256(canonical(result.definition)),
        wildcards: wildcardsIn(canonical(result.definition)),
        excludedFileCount: 0,
        mcp: result.definition,
      });
    }
  }
  return items;
}

async function scanMcpFile(
  ctx: Context,
  root: string,
  file: string,
  format: 'json' | 'toml',
  scope: InventoryScope,
): Promise<RawItem[]> {
  // The file's whole text may hold tokens next to the servers (`.claude.json` does),
  // so the check runs per definition, in readMcpEntry, and not on the file.
  const outcome = await readDefinitionFile(ctx, root, file, { maxBytes: ctx.limits.maxConfigFileBytes, allowAnyExtension: true, skipContentCheck: true });
  if (outcome === 'excluded' || outcome === 'missing') return [];
  const servers = format === 'toml' ? parseTomlMcpServers(outcome.file.text) : parseJsonMcpServers(outcome.file.text);
  if (!servers) {
    ctx.warnings.add(`mcp-config-unparsable:${outcome.file.relativePath}`);
    return [];
  }
  return mcpItems(ctx, servers, scope, outcome.file, (name) => (format === 'toml' ? `mcp_servers.${name}` : `mcpServers.${name}`));
}

interface StoredProjectSettings {
  defaultSkillsPath?: unknown;
  defaultAgentsPath?: unknown;
  agentDefaults?: ProjectAgentDefaults;
}

/** `.clubhouse/settings.json`, or its backup when it won't parse, as readSettings falls back. */
async function readProjectSettings(ctx: Context, projectPath: string): Promise<{ settings: StoredProjectSettings; file: ScannedFile | null }> {
  const main = path.join(projectPath, '.clubhouse', 'settings.json');
  for (const candidate of [main, `${main}.bak`]) {
    const outcome = await readDefinitionFile(ctx, projectPath, candidate, { maxBytes: ctx.limits.maxConfigFileBytes, skipContentCheck: true, allowAnyExtension: true });
    if (outcome === 'excluded') return { settings: {}, file: null };
    if (outcome === 'missing') {
      if (candidate === main) return { settings: {}, file: null };
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(outcome.file.text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        if (candidate !== main) ctx.warnings.add('settings-read-from-backup');
        return { settings: parsed as StoredProjectSettings, file: outcome.file };
      }
    } catch {
      // telemetry-exempt: the warning below reports it; a parse error can quote the file, so it goes nowhere
    }
    ctx.warnings.add('settings-unparsable');
  }
  return { settings: {}, file: null };
}

/** A value inside settings.json as an item of its own, hashed apart from the rest of the file. */
function settingsValueItem(
  ctx: Context,
  file: ScannedFile,
  kind: InventoryKind,
  name: string,
  pointer: string,
  serialized: string,
  builtinId: string | undefined,
): RawItem[] {
  if (hasSecretLookingContent(serialized)) {
    ctx.excluded['secret-looking']++;
    return [];
  }
  return [{
    kind, name, scope: 'project',
    root: file.root,
    path: file.path,
    pointer,
    files: [file],
    contentHash: sha256(serialized),
    wildcards: wildcardsIn(serialized),
    excludedFileCount: 0,
    builtinId,
  }];
}

function defaultsItems(ctx: Context, defaults: ProjectAgentDefaults, file: ScannedFile): RawItem[] {
  const items: RawItem[] = [];
  const table = builtins();
  if (typeof defaults.instructions === 'string' && defaults.instructions) {
    const isBuiltin = builtinHash(defaults.instructions) === table.instructions;
    items.push(...settingsValueItem(ctx, file, 'default-instructions', 'default instructions', 'agentDefaults.instructions', defaults.instructions, isBuiltin ? 'default-instructions' : undefined));
  }
  if (defaults.permissions && typeof defaults.permissions === 'object') {
    const serialized = canonical(defaults.permissions);
    items.push(...settingsValueItem(ctx, file, 'default-permissions', 'default permissions', 'agentDefaults.permissions', serialized, serialized === table.permissions ? 'default-permissions' : undefined));
  }
  if (typeof defaults.mcpJson === 'string' && defaults.mcpJson) {
    const servers = parseJsonMcpServers(defaults.mcpJson);
    if (servers) {
      items.push(...mcpItems(ctx, servers, 'project', file, (name) => `agentDefaults.mcpJson#${name}`));
    } else {
      ctx.warnings.add('default-mcp-json-unparsable');
    }
  }
  return items;
}

/** Where a project's source folder lives, honoring the setting the code honors, kept under `.clubhouse`. */
function sourceFolder(ctx: Context, projectPath: string, stored: unknown, fallback: string): string | null {
  const sub = typeof stored === 'string' && stored ? stored : fallback;
  const base = path.join(projectPath, '.clubhouse');
  const joined = confinedJoin(base, sub);
  if (!joined) ctx.warnings.add(`source-folder-outside-clubhouse:${fallback}`);
  return joined;
}

async function countMissions(ctx: Context, projectPath: string): Promise<number> {
  try {
    const dirents = await ctx.fs.readdir(path.join(projectPath, '.clubhouse', 'missions'));
    return dirents.filter((d) => d.isFile() && d.name.endsWith('.md')).length;
  } catch {
    // telemetry-exempt: a project without missions is the common case
    return 0;
  }
}

/**
 * Instructions in a worktree Clubhouse Mode doesn't write now, offered as found,
 * by agent, with the path. Nothing can say who wrote them: a persona applied
 * outside Clubhouse Mode writes expanded text here, and turning the mode off
 * leaves its output behind. The caveats on the source say so.
 */
async function scanAgentInstructions(ctx: Context, agent: DurableAgentConfig, worktree: string): Promise<RawItem[]> {
  const items: RawItem[] = [];
  for (const rel of INSTRUCTION_FILES) {
    const outcome = await readDefinitionFile(ctx, worktree, path.join(worktree, ...rel.split('/')));
    if (outcome === 'excluded' || outcome === 'missing') continue;
    const item = singleFileItem('agent-instructions', `${agent.name}/${rel}`, 'project', outcome.file);
    item.agent = { id: agent.id, name: agent.name };
    item.caveats = ['wildcards-may-be-expanded', 'git-state-is-a-hint'];
    items.push(item);
  }
  return items;
}

/**
 * MCP config files in a worktree holding something besides the bridge, counted
 * and not offered. A file that won't parse counts, since it can't be shown to be
 * only Clubhouse's. Its entries touch no project totals.
 */
async function countWorktreeMcpFiles(ctx: Context, worktree: string): Promise<number> {
  let count = 0;
  for (const { file, format } of PROJECT_MCP_FILES) {
    const before = { ...ctx.excluded };
    const outcome = await readDefinitionFile(ctx, worktree, path.join(worktree, ...file.split('/')), { maxBytes: ctx.limits.maxConfigFileBytes, allowAnyExtension: true, skipContentCheck: true });
    if (outcome === 'missing') continue;
    if (outcome === 'excluded') {
      // A file over the limit or unreadable can't be shown to be only Clubhouse's either.
      if (before['over-limit'] === ctx.excluded['over-limit']) count++;
      continue;
    }
    const servers = format === 'toml' ? parseTomlMcpServers(outcome.file.text) : parseJsonMcpServers(outcome.file.text);
    if (!servers || Object.values(servers).some((entry) => readMcpEntry(entry).kind !== 'bridge')) count++;
  }
  return count;
}

async function scanProviderFolders(ctx: Context, root: string, scope: InventoryScope, configDirs: readonly string[]): Promise<RawItem[]> {
  const items: RawItem[] = [];
  for (const dir of configDirs) {
    items.push(...await scanFolderItems(ctx, root, path.join(root, dir, 'skills'), 'skill', scope));
    items.push(...await scanFolderItems(ctx, root, path.join(root, dir, 'agents'), 'agent-template', scope));
  }
  return items;
}

// ── Stored Clubhouse Mode settings ───────────────────────────────────────

interface StoredMode {
  state: 'ok' | 'unreadable';
  enabled: boolean;
  overrides: Record<string, unknown>;
}

async function readStoredMode(): Promise<StoredMode> {
  const stored = await peekStoredSettings(CLUBHOUSE_MODE_SETTINGS_FILE);
  if (stored === 'missing') return { state: 'ok', enabled: false, overrides: {} };
  if (stored === 'unreadable') return { state: 'unreadable', enabled: false, overrides: {} };
  return { state: 'ok', enabled: stored.enabled === true, overrides: overridesIn(stored) };
}

/** Mirrors isClubhouseModeEnabled, from what's on disk and without its store's cache. */
function resolveMode(mode: StoredMode, projectPath: string): InventoryClubhouseMode {
  if (mode.state === 'unreadable') return { enabled: 'unknown', source: 'unknown' };
  const override = mode.overrides[projectPath];
  if (override !== undefined) return { enabled: !!override, source: 'project' };
  return { enabled: mode.enabled, source: 'app' };
}

// ── One project ──────────────────────────────────────────────────────────

interface ProjectScan {
  items: RawItem[];
  missionsNotInventoried: number;
  clubhouseMode: InventoryClubhouseMode;
  agents: InventoryAgentReport[];
}

async function scanProject(
  ctx: Context,
  projectPath: string,
  mode: InventoryClubhouseMode,
  includeProviderConfig: boolean,
): Promise<ProjectScan> {
  const items: RawItem[] = [];
  const { settings, file: settingsFile } = await readProjectSettings(ctx, projectPath);
  const defaults: ProjectAgentDefaults = settings.agentDefaults && typeof settings.agentDefaults === 'object' ? settings.agentDefaults : {};

  const skillsDir = sourceFolder(ctx, projectPath, settings.defaultSkillsPath, 'skills');
  const skills = skillsDir ? await scanFolderItems(ctx, projectPath, skillsDir, 'skill', 'project') : [];
  const templatesDir = sourceFolder(ctx, projectPath, settings.defaultAgentsPath, 'agent-templates');
  const templates = templatesDir ? await scanFolderItems(ctx, projectPath, templatesDir, 'agent-template', 'project') : [];
  items.push(...skills, ...templates);
  items.push(...await scanPersonaFolder(ctx, projectPath, path.join(projectPath, '.clubhouse', 'personas'), 'project'));
  if (settingsFile) items.push(...defaultsItems(ctx, defaults, settingsFile));

  for (const { file, format } of PROJECT_MCP_FILES) {
    items.push(...await scanMcpFile(ctx, projectPath, path.join(projectPath, ...file.split('/')), format, 'project'));
  }

  const agents: InventoryAgentReport[] = [];
  for (const agent of await peekDurableConfigs(projectPath)) {
    await checkpoint(ctx);
    // The rule agent-system applies before materializing at wake.
    const managed: boolean | 'unknown' = !agent.worktreePath
      ? false
      : mode.enabled === 'unknown' ? 'unknown' : mode.enabled && !agent.clubhouseModeOverride;
    const report: InventoryAgentReport = {
      id: agent.id, name: agent.name, worktreePath: agent.worktreePath, managed,
      status: 'no-worktree',
      persona: agent.persona ?? defaults.persona,
      mission: agent.mission ?? defaults.mission,
      mcpFilesNotInventoried: 0,
    };
    agents.push(report);
    if (!agent.worktreePath) continue;
    if (managed === true) {
      report.status = 'generated';
      continue;
    }
    if (managed === 'unknown') {
      report.status = 'skipped-mode-unknown';
      continue;
    }
    try {
      await ctx.fs.stat(agent.worktreePath);
    } catch (err) {
      // telemetry-exempt: reported on the agent; a worktree that's gone doesn't stop the project
      if (!isMissing(err)) ctx.warnings.add(`worktree-unavailable:${errorCode(err)}`);
      report.status = 'missing-worktree';
      continue;
    }
    report.status = 'scanned';
    items.push(...await scanAgentInstructions(ctx, agent, agent.worktreePath));
    report.mcpFilesNotInventoried = await countWorktreeMcpFiles(ctx, agent.worktreePath);
  }

  if (includeProviderConfig) {
    items.push(...await scanProviderFolders(ctx, projectPath, 'provider', PROVIDER_CONFIG_DIRS));
    for (const rel of INSTRUCTION_FILES) {
      const outcome = await readDefinitionFile(ctx, projectPath, path.join(projectPath, ...rel.split('/')));
      if (outcome !== 'excluded' && outcome !== 'missing') items.push(singleFileItem('provider-instructions', rel, 'provider', outcome.file));
    }
  }

  const clubhouseMode: InventoryClubhouseMode = { ...mode };
  if (mode.enabled === true) {
    const permissions = defaults.permissions;
    const mcpNames = typeof defaults.mcpJson === 'string' ? parseJsonMcpServers(defaults.mcpJson) : null;
    clubhouseMode.effective = {
      hasInstructions: !!defaults.instructions,
      permissionRuleCount: (permissions?.allow?.length ?? 0) + (permissions?.deny?.length ?? 0),
      mcpServerNames: Object.keys(mcpNames ?? {}).sort(),
      skills: skills.map((s) => s.name),
      agentTemplates: templates.map((t) => t.name),
      defaultPersona: defaults.persona,
      defaultMission: defaults.mission,
    };
  }

  return {
    items,
    missionsNotInventoried: await countMissions(ctx, projectPath),
    clubhouseMode,
    agents,
  };
}

async function scanGlobal(ctx: Context, homeDir: string, baseDir: string): Promise<RawItem[]> {
  const items: RawItem[] = [];
  items.push(...await scanProviderFolders(ctx, homeDir, 'global', GLOBAL_SOURCES.map((s) => s.dir)));
  for (const source of GLOBAL_SOURCES) {
    if (source.instructions) {
      const file = path.join(homeDir, source.dir, source.instructions);
      const outcome = await readDefinitionFile(ctx, homeDir, file);
      if (outcome !== 'excluded' && outcome !== 'missing') items.push(singleFileItem('provider-instructions', `${source.dir}/${source.instructions}`, 'global', outcome.file));
    }
    if (source.mcp) {
      items.push(...await scanMcpFile(ctx, homeDir, path.join(homeDir, ...source.mcp.file.split('/')), source.mcp.format, 'global'));
    }
  }
  items.push(...await scanPersonaFolder(ctx, baseDir, path.join(baseDir, 'personas'), 'global'));
  return items;
}

// ── Output ───────────────────────────────────────────────────────────────

/** Ask git about each file once, whichever items share it, and fill in the sources. */
async function toSources(items: readonly RawItem[], signal: AbortSignal, project: { id: string; name: string } | null): Promise<Map<RawItem, InventorySource>> {
  const byRoot = new Map<string, Set<string>>();
  for (const item of items) {
    const paths = byRoot.get(item.root) ?? new Set<string>();
    for (const file of item.files) paths.add(file.relativePath);
    byRoot.set(item.root, paths);
  }
  const states = new Map<string, Awaited<ReturnType<typeof readGitStates>>>();
  for (const [root, paths] of byRoot) {
    states.set(root, await readGitStates(root, [...paths], signal));
    if (signal.aborted) throw new ScanStopped();
  }
  const sources = new Map<RawItem, InventorySource>();
  for (const item of items) {
    const files: InventoryFile[] = item.files.map((f) => ({
      path: f.path,
      relativePath: f.relativePath,
      gitState: states.get(item.root)?.get(f.relativePath) ?? 'unknown',
      contentHash: f.contentHash,
      sizeBytes: f.sizeBytes,
    }));
    const source: InventorySource = {
      projectId: project?.id ?? null,
      projectName: project?.name ?? null,
      root: item.root,
      path: item.path,
      files,
      excludedFileCount: item.excludedFileCount,
    };
    if (item.pointer) source.pointer = item.pointer;
    if (item.agent) source.agent = item.agent;
    if (item.caveats) source.caveats = item.caveats;
    sources.set(item, source);
  }
  // File text has done its work; a large install shouldn't hold it for the rest of the scan.
  for (const item of items) item.files = [];
  return sources;
}

interface Sourced {
  item: RawItem;
  source: InventorySource;
}

/** Same kind, name and hash merge; the same name with another hash is a conflict. Names compare without case, as a folder would. */
export function mergeEntries(sourced: readonly Sourced[]): InventoryEntry[] {
  const nameKey = (s: { kind: string; name: string }) => `${s.kind}\0${s.name.toLowerCase()}`;
  const byContent = new Map<string, InventoryEntry>();
  const hashesByName = new Map<string, Set<string>>();
  for (const { item, source } of sourced) {
    // Scope stays apart in the key, so a global source is never labeled as its project twin's.
    const key = `${nameKey(item)}\0${item.scope}\0${item.contentHash}`;
    const existing = byContent.get(key);
    if (existing) {
      existing.sources.push(source);
    } else {
      const entry: InventoryEntry = {
        kind: item.kind,
        name: item.name,
        scope: item.scope,
        contentHash: item.contentHash,
        wildcards: item.wildcards,
        sources: [source],
        conflict: false,
        conflictingHashes: [],
      };
      if (item.mcp) entry.mcp = item.mcp;
      if (item.persona) entry.persona = item.persona;
      byContent.set(key, entry);
    }
    const hashes = hashesByName.get(nameKey(item)) ?? new Set<string>();
    hashes.add(item.contentHash);
    hashesByName.set(nameKey(item), hashes);
  }
  const entries = [...byContent.values()];
  for (const entry of entries) {
    const hashes = hashesByName.get(nameKey(entry)) ?? new Set<string>();
    entry.conflict = hashes.size > 1;
    entry.conflictingHashes = [...hashes].filter((h) => h !== entry.contentHash).sort();
  }
  return entries.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.contentHash.localeCompare(b.contentHash));
}

function mergeBuiltinMatches(sourced: readonly Sourced[]): InventoryBuiltinMatch[] {
  const merged = new Map<string, InventoryBuiltinMatch>();
  for (const { item, source } of sourced) {
    const builtinId = item.builtinId as string;
    const key = `${item.kind}\0${item.name}\0${builtinId}\0${item.contentHash}`;
    const existing = merged.get(key);
    if (existing) existing.sources.push(source);
    else merged.set(key, { kind: item.kind, name: item.name, builtinId, contentHash: item.contentHash, sources: [source] });
  }
  return [...merged.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

function overridesIn(stored: Awaited<ReturnType<typeof peekStoredSettings>>): Record<string, unknown> {
  const overrides = typeof stored === 'object' ? stored.projectOverrides : undefined;
  return overrides && typeof overrides === 'object' && !Array.isArray(overrides) ? overrides as Record<string, unknown> : {};
}

function orphanedConfig(
  settingsFile: string,
  overrides: Record<string, unknown>,
  registered: readonly { path: string }[],
  missingPaths: ReadonlySet<string>,
): InventoryOrphanedConfig[] {
  const registeredExact = new Set(registered.map((p) => p.path));
  const registeredKeys = new Set(registered.map((p) => projectPathKey(p.path)));
  const orphaned: InventoryOrphanedConfig[] = [];
  for (const stored of Object.keys(overrides)) {
    let reason: InventoryOrphanedConfig['reason'] | null = null;
    if (registeredExact.has(stored)) reason = missingPaths.has(stored) ? 'project-missing' : null;
    else reason = registeredKeys.has(projectPathKey(stored)) ? 'path-variant' : 'unregistered';
    if (reason) orphaned.push({ settingsFile, path: stored, reason });
  }
  return orphaned;
}

/**
 * Races a scan against its deadline and the cancel. A call stuck on a dead mount
 * never settles, so this can't simply await it; the scan's own signal stops the
 * rest of its work once the call returns.
 */
async function withDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  outer: AbortSignal,
  timeoutMs: number,
): Promise<{ value: T } | { stopped: 'cancelled' | 'timeout' }> {
  const inner = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<'cancelled' | 'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    onAbort = () => resolve('cancelled');
    outer.addEventListener('abort', onAbort, { once: true });
    if (outer.aborted) resolve('cancelled');
  });
  const scan = run(inner.signal);
  // Past the deadline nobody is left to hear how it ended.
  scan.catch((): void => undefined);
  try {
    const winner = await Promise.race([scan.then((value) => ({ value })), stop.then((stopped) => ({ stopped }))]);
    if ('stopped' in winner) inner.abort();
    return winner;
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) outer.removeEventListener('abort', onAbort);
  }
}

/**
 * Scan the registered projects and report what could be imported. Reads only,
 * and runs only when called. A project that is missing, offline or slow gets a
 * status of its own and the rest carry on. On cancel the result holds the
 * projects that finished.
 */
export async function scanImportInventory(options: InventoryOptions = {}): Promise<ImportInventory> {
  const fs = options.fs ?? REAL_FS;
  const limits = { ...DEFAULT_INVENTORY_LIMITS, ...options.limits };
  const outerSignal = options.signal ?? new AbortController().signal;
  const timeoutMs = options.projectTimeoutMs ?? DEFAULT_PROJECT_TIMEOUT_MS;
  const includeProviderConfig = options.includeProviderConfig === true;
  // Never run synchronously inside the caller's tick.
  await new Promise<void>((resolve) => setImmediate(resolve));

  const report = (progress: InventoryProgress) => {
    try {
      options.onProgress?.(progress);
    } catch {
      // telemetry-exempt: a progress listener's failure must not stop a scan it only watches
    }
  };

  const registered = await peekProjects();
  const selected = options.projectIds
    ? registered.filter((p) => options.projectIds?.includes(p.id))
    : registered;
  const storedMode = await readStoredMode();

  const projects: InventoryProjectReport[] = [];
  const projectSourced: Sourced[] = [];
  const missingPaths = new Set<string>();
  let cancelled = false;

  for (const [index, project] of selected.entries()) {
    const projectReport: InventoryProjectReport = {
      projectId: project.id,
      projectName: project.displayName ?? project.name,
      projectPath: project.path,
      status: 'not-started',
      truncated: false,
      filesSeen: 0,
      excluded: emptyExclusions(),
      bridgeEntriesFiltered: 0,
      missionsNotInventoried: 0,
      warnings: [],
      clubhouseMode: resolveMode(storedMode, project.path),
      agents: [],
    };
    projects.push(projectReport);
    if (outerSignal.aborted) {
      cancelled = true;
      continue;
    }
    report({ phase: 'project-started', projectIndex: index, projectCount: selected.length, projectName: projectReport.projectName, filesSeen: 0 });

    let ctx: Context | null = null;
    const outcome = await withDeadline(async (signal) => {
      ctx = newContext(fs, limits, signal, (filesSeen) => {
        report({ phase: 'files', projectIndex: index, projectCount: selected.length, projectName: projectReport.projectName, filesSeen });
      });
      const stats = await fs.stat(project.path);
      if (!stats.isDirectory()) return { unavailable: 'ENOTDIR' as const };
      const scan = await scanProject(ctx, project.path, projectReport.clubhouseMode, includeProviderConfig);
      const sources = await toSources(scan.items, signal, { id: project.id, name: projectReport.projectName });
      return { scan, sources };
    }, outerSignal, timeoutMs).catch((err: unknown) => {
      // telemetry-exempt: reported on the project as a code; the error's message isn't kept
      if (err instanceof ScanStopped) return { stopped: 'cancelled' as const };
      return { failed: err };
    });

    const finished = ctx as Context | null;
    if (finished) {
      projectReport.filesSeen = finished.filesSeen;
      projectReport.excluded = finished.excluded;
      projectReport.truncated = finished.truncated;
      projectReport.bridgeEntriesFiltered = finished.bridgeFiltered;
      projectReport.warnings = [...finished.warnings].sort();
    }

    if ('stopped' in outcome) {
      if (outcome.stopped === 'cancelled') {
        projectReport.status = 'cancelled';
        cancelled = true;
      } else {
        projectReport.status = 'unavailable';
        projectReport.reason = 'timeout';
      }
    } else if ('failed' in outcome) {
      if (isMissing(outcome.failed)) {
        projectReport.status = 'missing';
        missingPaths.add(project.path);
      } else {
        projectReport.status = 'unavailable';
        projectReport.reason = errorCode(outcome.failed);
      }
    } else if ('unavailable' in outcome.value) {
      projectReport.status = 'unavailable';
      projectReport.reason = outcome.value.unavailable;
    } else {
      const { scan, sources } = outcome.value;
      projectReport.status = 'scanned';
      projectReport.clubhouseMode = scan.clubhouseMode;
      projectReport.agents = scan.agents;
      projectReport.missionsNotInventoried = scan.missionsNotInventoried;
      for (const [item, source] of sources) projectSourced.push({ item, source });
    }
    report({ phase: 'project-finished', projectIndex: index, projectCount: selected.length, projectName: projectReport.projectName, filesSeen: projectReport.filesSeen });
  }

  // Only a project known missing makes a stored override orphaned: one not looked at this run may be fine.
  const orphaned = orphanedConfig(CLUBHOUSE_MODE_SETTINGS_FILE, storedMode.overrides, registered, missingPaths);
  for (const settingsFile of OTHER_OVERRIDE_SETTINGS_FILES) {
    orphaned.push(...orphanedConfig(settingsFile, overridesIn(await peekStoredSettings(settingsFile)), registered, missingPaths));
  }
  orphaned.sort((a, b) => a.path.localeCompare(b.path) || a.settingsFile.localeCompare(b.settingsFile));

  const globalSourced: Sourced[] = [];
  let globalExcluded = emptyExclusions();
  let globalStatus: ImportInventory['globalStatus'] = 'not-requested';
  if (includeProviderConfig && !outerSignal.aborted) {
    report({ phase: 'global', projectIndex: selected.length, projectCount: selected.length, filesSeen: 0 });
    let ctx: Context | null = null;
    const outcome = await withDeadline(async (signal) => {
      ctx = newContext(fs, limits, signal);
      const items = await scanGlobal(ctx, options.homeDir ?? os.homedir(), getBaseDirPath());
      return toSources(items, signal, null);
    }, outerSignal, timeoutMs).catch((err: unknown) => {
      // telemetry-exempt: global config is optional; a failure leaves it out and the projects stand
      return err instanceof ScanStopped ? { stopped: 'cancelled' as const } : { failed: true as const };
    });
    const finished = ctx as Context | null;
    if (finished) globalExcluded = finished.excluded;
    if ('value' in outcome) {
      globalStatus = 'scanned';
      for (const [item, source] of outcome.value) globalSourced.push({ item, source });
    } else {
      globalStatus = 'stopped' in outcome && outcome.stopped === 'cancelled' ? 'cancelled' : 'unavailable';
    }
  }
  if (outerSignal.aborted) cancelled = true;

  const offered = (s: Sourced) => !s.item.builtinId;
  const inProject = projectSourced.filter((s) => s.item.scope === 'project');
  const providerSourced = [...projectSourced.filter((s) => s.item.scope !== 'project'), ...globalSourced];

  const inventory: ImportInventory = {
    version: 1,
    status: cancelled ? 'cancelled' : 'complete',
    entries: mergeEntries(inProject.filter(offered)),
    providerEntries: mergeEntries(providerSourced.filter(offered)),
    builtinMatches: mergeBuiltinMatches([...inProject, ...providerSourced].filter((s) => !offered(s))),
    projects,
    orphaned,
    globalStatus,
    globalExcluded,
  };

  // Counts only: paths and names can be private, and contents never reach this far.
  appLog(LOG_NS, 'info', 'Import inventory finished', {
    meta: {
      status: inventory.status,
      projects: projects.length,
      entries: inventory.entries.length,
      providerEntries: inventory.providerEntries.length,
      builtinMatches: inventory.builtinMatches.length,
      orphaned: orphaned.length,
    },
  });
  return inventory;
}
