/**
 * Delivery for Clubhouse-managed agents (#2896). At each session start the
 * agent gets exactly its setup: its instruction blocks joined in order, its
 * skills copied into its own folder, and its MCP servers. Clubhouse adds no
 * instruction text of its own.
 *
 * Works for every CLI and both runtimes because it writes where each CLI
 * already reads (the provider's instructions file, skills folder and MCP
 * file) and hands the MCP servers to the existing launch merge points.
 */
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { composeInstructions } from '../asset-catalog/composer';
import { canonicalHash } from '../asset-catalog/planner';
import { replaceManagedWildcards } from '../../../shared/wildcard-replacer';
import { buildWildcardContext } from '../agent-wildcards';
import { appLog } from '../log-service';
import type { DurableAgentConfig, McpServerDef } from '../../../shared/types';
import type { OrchestratorProvider } from '../../orchestrators/types';
import {
  CLUBHOUSE_MCP_PART_ID,
  type ManagedAgentSetup,
  type ManagedMcpContent,
  type ManagedPreview,
  type ManagedSkillContent,
} from '../../../shared/managed-agents-types';
import { withClubhouseSetup, type ManagedAgentsService } from './service';
import { withWorkingIdentity } from './builtins';
import { skillsFolderOf } from '../../../shared/skills-folder';

/** Written beside the managed skills so a later start removes only what Clubhouse put there. */
const SKILLS_MANIFEST = '.clubhouse-managed-skills.json';
/** In the worktree: the `claudeMdExcludes` entries Clubhouse added, so it replaces only those (D49). Git-excluded. */
export const EXCLUDES_MANIFEST = '.clubhouse-managed-excludes.json';

interface Resolved {
  blocks: Array<{ id: string; name: string; builtin: boolean; revision: number; content: string }>;
  skills: Array<{ id: string; name: string; revision: number; content: ManagedSkillContent }>;
  /** `droppedEnvValues`: env names the part stored literal values for, which now come from the environment (D46). */
  mcps: Array<{ id: string; name: string; revision: number; builtin: boolean; content: ManagedMcpContent; droppedEnvValues: string[] }>;
  missing: string[];
}

async function resolveSetup(service: ManagedAgentsService, saved: ManagedAgentSetup): Promise<Resolved> {
  // Both sides of the delivery fingerprint (delivered and current) resolve here,
  // so a setup saved before the Clubhouse part was required fingerprints the same.
  const setup = withClubhouseSetup(saved);
  const out: Resolved = { blocks: [], skills: [], mcps: [], missing: [] };
  for (const id of setup.blocks) {
    const head = await service.headContent(id);
    if (!head || head.content.kind !== 'block') { out.missing.push(id); continue; }
    out.blocks.push({ id, name: head.entry.name, builtin: head.entry.source.kind === 'builtin', revision: head.entry.headRevision, content: head.content.content });
  }
  for (const id of setup.skills) {
    const head = await service.headContent(id);
    if (!head || head.content.kind !== 'skill') { out.missing.push(id); continue; }
    out.skills.push({ id, name: head.entry.name, revision: head.entry.headRevision, content: head.content });
  }
  for (const id of setup.mcps) {
    const head = await service.headContent(id);
    if (!head || head.content.kind !== 'mcp') { out.missing.push(id); continue; }
    out.mcps.push({ id, name: head.entry.name, revision: head.entry.headRevision, builtin: head.entry.source.kind === 'builtin', content: head.content, droppedEnvValues: head.droppedEnvValues });
  }
  return out;
}

/**
 * The wildcard context for a managed agent's text, the same for delivery and
 * Preview. Only @@AgentName, @@StandbyBranch and @@Path are filled
 * (MANAGED_WILDCARDS): @@SourceControlProvider, @@BuildCommand, @@TestCommand
 * and @@LintCommand stay as written (#2902), like @@If blocks (D10) and
 * @@Mission and @@Persona (D60).
 */
function wildcardContextFor(projectPath: string, agent: DurableAgentConfig) {
  return buildWildcardContext(agent, projectPath);
}

/** What the setup renders to, with wildcards filled in for this agent. */
export async function renderManagedInstructions(projectPath: string, agent: DurableAgentConfig, resolved: Resolved): Promise<string> {
  const composed = composeInstructions(resolved.blocks.map((b) => ({ content: b.content })));
  if (composed.ok === false) throw new Error(composed.code);
  return replaceManagedWildcards(composed.text, wildcardContextFor(projectPath, agent));
}

/** The MCP servers a managed agent gets, as the providers' launch code takes them. The Clubhouse bridge is separate. */
export function mcpServersOf(resolved: Resolved): Record<string, McpServerDef> {
  const servers: Record<string, McpServerDef> = {};
  for (const mcp of resolved.mcps) {
    if (mcp.id === CLUBHOUSE_MCP_PART_ID || mcp.content.serverKey === 'clubhouse') continue;
    const c = mcp.content;
    const def: McpServerDef = c.transport === 'stdio'
      ? { command: c.command, ...(c.args && c.args.length > 0 && { args: [...c.args] }) }
      : { type: c.transport, url: c.url };
    // Names only: values come from the signed-in environment, never from Clubhouse (D46).
    if (c.envVars && c.envVars.length > 0) def.env_vars = [...c.envVars];
    servers[c.serverKey] = def;
  }
  return servers;
}

export async function resolveManagedMcpServers(service: ManagedAgentsService, agent: DurableAgentConfig): Promise<Record<string, McpServerDef>> {
  if (!agent.managed) return {};
  return mcpServersOf(await resolveSetup(service, agent.managed));
}

function insideDir(dir: string, rel: string): string {
  const target = path.resolve(dir, rel);
  if (target !== dir && !target.startsWith(dir + path.sep)) throw new Error(`skill file escapes its folder: ${rel}`);
  return target;
}

/**
 * A folder Clubhouse didn't write is never deleted: it's moved to app data
 * first, so a managed skill with the same folder name can take its place.
 */
async function moveAside(dir: string, backupRoot: string | undefined): Promise<void> {
  if (!backupRoot) throw new Error(`a folder Clubhouse didn't write is in the way: ${path.basename(dir)}`);
  const target = path.join(backupRoot, `${path.basename(dir)}-${Date.now()}`);
  await fsp.mkdir(backupRoot, { recursive: true });
  await fsp.cp(dir, target, { recursive: true });
  await fsp.rm(dir, { recursive: true, force: true });
  appLog('core:managed', 'info', 'Moved a skill folder Clubhouse did not write out of the way', { meta: { folder: path.basename(dir) } });
}

/** Whether `target` is `base` or inside it, both already absolute. */
function isWithin(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Whether `target` sits inside `base` with no symlink (or junction) on the
 * way down, and still does once links are resolved. A linked skills folder
 * would make a move empty a folder outside the agent's (D48).
 */
export async function insideWithoutLinks(base: string, target: string): Promise<boolean> {
  if (!isWithin(base, target)) return false;
  let cur = base;
  for (const part of path.relative(base, target).split(path.sep).filter(Boolean)) {
    cur = path.join(cur, part);
    try {
      if ((await fsp.lstat(cur)).isSymbolicLink()) return false;
    } catch {
      // telemetry-exempt: can't be checked, so it isn't treated as safe to move from.
      return false;
    }
  }
  try {
    const [realBase, realTarget] = await Promise.all([fsp.realpath(base), fsp.realpath(target)]);
    return isWithin(realBase, realTarget);
  } catch {
    // telemetry-exempt: can't be resolved, so it isn't treated as safe to move from.
    return false;
  }
}

export type TrackedFiles = { ok: true; files: string[] } | { ok: false; code: string };

/**
 * Files git tracks under `rels` in `cwd`, relative with forward slashes.
 * None when `cwd` isn't in a git checkout. Any other failure (git missing,
 * dubious ownership, a timeout, too much output) gives its error code, so a
 * caller never mistakes it for "nothing is tracked".
 */
export function trackedFiles(cwd: string, rels: string[]): Promise<TrackedFiles> {
  if (rels.length === 0) return Promise.resolve({ ok: true, files: [] });
  return new Promise((resolve) => {
    // LC_ALL=C keeps git's messages in English, so "not a git repository" can be recognized.
    execFile('git', ['--literal-pathspecs', 'ls-files', '-z', '--', ...rels], { cwd, timeout: 10_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, env: { ...process.env, LC_ALL: 'C' } }, (err, stdout, stderr) => {
      if (err) {
        // telemetry-exempt: not a git checkout, so nothing is tracked.
        if (/not a git repository/i.test(String(stderr))) { resolve({ ok: true, files: [] }); return; }
        const e = err as NodeJS.ErrnoException & { signal?: NodeJS.Signals | null; code?: string | number | null };
        // telemetry-exempt: the caller logs the code and moves nothing.
        resolve({ ok: false, code: String(e.code ?? e.signal ?? 'unknown') });
        return;
      }
      resolve({ ok: true, files: String(stdout).split('\0').filter(Boolean).map((f) => f.replace(/\\/g, '/')) });
    });
  });
}

interface OtherSkillFolders {
  tracked: string[];
  untracked: string[];
  /** Folders left in place because Clubhouse couldn't be sure moving them was safe. */
  kept: string[];
  /** Why `kept` isn't empty: the skills folder is a link, or git couldn't say what it tracks. */
  keptReason?: 'link' | 'git';
  gitErrorCode?: string;
}

/**
 * The folders in the managed skills directory that aren't the setup's skills.
 * The CLI would load them too, so delivery moves the untracked ones out
 * (D48). Folders git tracks can't move without dirtying the worktree, so
 * they stay and Preview lists them. Nothing moves when the skills folder is
 * reached through a link, or when git couldn't answer.
 */
async function otherSkillFolders(worktree: string, provider: OrchestratorProvider, current: string[]): Promise<OtherSkillFolders> {
  const conv = provider.conventions;
  const root = path.join(worktree, skillsFolderOf(conv));
  let names: string[] = [];
  try {
    names = (await fsp.readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !current.includes(e.name))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch { /* telemetry-exempt: no skills folder yet, so nothing else is loaded from it */ }
  if (names.length === 0) return { tracked: [], untracked: [], kept: [] };
  if (!(await insideWithoutLinks(worktree, root))) return { tracked: [], untracked: [], kept: names, keptReason: 'link' };
  const rel = skillsFolderOf(conv);
  const listed = await trackedFiles(worktree, names.map((n) => `${rel}/${n}`));
  if (listed.ok === false) return { tracked: [], untracked: [], kept: names, keptReason: 'git', gitErrorCode: listed.code };
  // A submodule (gitlink) is listed as the folder itself, with no trailing slash.
  const tracked = names.filter((n) => listed.files.some((f) => f === `${rel}/${n}` || f.startsWith(`${rel}/${n}/`)));
  return { tracked, untracked: names.filter((n) => !tracked.includes(n)), kept: [] };
}

/**
 * Remove the skills Clubhouse delivered to a folder the CLI no longer reads
 * (Codex's `.codex/skills`, now `.agents/skills`): exactly the folders that
 * folder's managed-skills manifest lists, then the manifest. Anything else
 * there is left alone, and nothing is removed through a link.
 */
async function removePreviousManagedSkills(worktree: string, provider: OrchestratorProvider): Promise<void> {
  for (const rel of provider.conventions.previousSkillsRoots ?? []) {
    const root = path.join(worktree, rel);
    let listed: string[];
    try {
      const raw = JSON.parse(await fsp.readFile(path.join(root, SKILLS_MANIFEST), 'utf-8'));
      listed = Array.isArray(raw?.skills) ? raw.skills.filter((x: unknown): x is string => typeof x === 'string') : [];
    } catch { continue; /* telemetry-exempt: Clubhouse never delivered skills there */ }
    if (!(await insideWithoutLinks(worktree, root))) {
      appLog('core:managed', 'warn', 'The previous skills folder is a link; its managed skills were left in place', { meta: { folders: listed.length } });
      continue;
    }
    for (const name of listed) {
      // Only a plain folder name in the manifest: never the folder itself or anything outside it.
      if (!name || name !== path.basename(name) || name === '.' || name === '..') continue;
      await fsp.rm(insideDir(root, name), { recursive: true, force: true });
    }
    await fsp.rm(path.join(root, SKILLS_MANIFEST), { force: true });
  }
}

async function writeSkills(worktree: string, provider: OrchestratorProvider, skills: Resolved['skills'], backupRoot?: string): Promise<void> {
  await removePreviousManagedSkills(worktree, provider);
  const conv = provider.conventions;
  const root = path.join(worktree, skillsFolderOf(conv));
  await fsp.mkdir(root, { recursive: true });
  // A linked skills folder (or .claude) leads outside the agent's folder: nothing is moved out of it (D48).
  const safeToMove = await insideWithoutLinks(worktree, root);
  let previous: string[] = [];
  try {
    const raw = JSON.parse(await fsp.readFile(path.join(root, SKILLS_MANIFEST), 'utf-8'));
    if (Array.isArray(raw?.skills)) previous = raw.skills.filter((x: unknown): x is string => typeof x === 'string');
  } catch { /* telemetry-exempt: first managed start, or the manifest was removed */ }
  const current = skills.map((s) => s.content.skillName);
  for (const name of previous) {
    if (current.includes(name)) continue;
    await fsp.rm(insideDir(root, name), { recursive: true, force: true });
  }
  for (const skill of skills) {
    const dir = insideDir(root, skill.content.skillName);
    let exists = false;
    try { exists = (await fsp.stat(dir)).isDirectory(); } catch { /* telemetry-exempt: not there yet */ }
    if (exists && !previous.includes(skill.content.skillName)) {
      if (!safeToMove) throw new Error(`the skills folder is a link to somewhere outside the agent's folder, so Clubhouse won't move ${skill.content.skillName} out of the way`);
      await moveAside(dir, backupRoot);
    }
    // Replace the folder whole, so a file removed from the skill doesn't linger.
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });
    for (const file of skill.content.files) {
      const target = insideDir(dir, file.path);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      const data = file.encoding === 'base64' ? Buffer.from(file.content, 'base64') : file.content;
      await fsp.writeFile(target, data);
      if (file.executable && process.platform !== 'win32') await fsp.chmod(target, 0o755);
    }
  }
  await fsp.writeFile(path.join(root, SKILLS_MANIFEST), JSON.stringify({ skills: current }, null, 2), 'utf-8');
  // Exactly its skills: anything else here would load too, so it moves to app data (D48).
  if (backupRoot) {
    const other = await otherSkillFolders(worktree, provider, current);
    if (other.keptReason === 'link') {
      appLog('core:managed', 'warn', 'The skills folder is a link; no skill folders were moved', { meta: { folders: other.kept.length } });
    } else if (other.keptReason === 'git') {
      appLog('core:managed', 'warn', 'git could not list tracked skill folders; none were moved', { meta: { code: other.gitErrorCode } });
    }
    for (const name of other.untracked) await moveAside(insideDir(root, name), backupRoot);
  }
}

// ── Instruction files the CLI reads besides Clubhouse's ────────────────

const CLAUDE_CODE_ID = 'claude-code';
const COPILOT_ID = 'copilot-cli';

function forwardSlashes(p: string): string {
  return p.replace(/\\/g, '/');
}

/** An absolute path as a picomatch pattern that matches only itself. */
function literalPattern(abs: string): string | null {
  const p = forwardSlashes(abs);
  if (!/[*?[\]{}()!+@]/.test(p)) return p;
  // A backslash escape means a path separator on Windows: leave such a file out rather than guess.
  if (process.platform === 'win32') return null;
  return p.replace(/[*?[\]{}()!+@]/g, '\\$&');
}

/**
 * Whether two paths are the same folder: compared after resolving links (a
 * path that can't be resolved is compared as written), and ignoring case on
 * Windows.
 */
export async function isSameFolder(a: string, b: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  const real = (p: string) => fsp.realpath(p).catch((): string => path.resolve(p));
  const [ra, rb] = await Promise.all([real(a), real(b)]);
  return platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

export interface ParentInstructionFile {
  /** Absolute path. */
  path: string;
  /** The same path with symlinks resolved, when it differs: the CLI may see either. */
  realPath?: string;
  /** A `.claude/rules` folder rather than a file. */
  folder: boolean;
}

/**
 * The instruction files above the agent's folder that Claude Code reads as
 * project memory: CLAUDE.md, CLAUDE.local.md, .claude/CLAUDE.md and
 * .claude/rules in every parent folder up to the root. The home folder's
 * .claude is the person's user memory and is left out (D49).
 */
export async function parentInstructionFiles(worktree: string): Promise<ParentInstructionFile[]> {
  const out: ParentInstructionFile[] = [];
  const home = os.homedir();
  let dir = path.dirname(path.resolve(worktree));
  for (;;) {
    const isHome = await isSameFolder(dir, home);
    const candidates: ParentInstructionFile[] = [
      { path: path.join(dir, 'CLAUDE.md'), folder: false },
      { path: path.join(dir, 'CLAUDE.local.md'), folder: false },
      ...(isHome ? [] : [
        { path: path.join(dir, '.claude', 'CLAUDE.md'), folder: false },
        { path: path.join(dir, '.claude', 'rules'), folder: true },
      ]),
    ];
    for (const c of candidates) {
      try {
        const st = await fsp.stat(c.path);
        if (!(c.folder ? st.isDirectory() : st.isFile())) continue;
        const real = await fsp.realpath(c.path).catch((): string => c.path);
        out.push(real !== c.path ? { ...c, realPath: real } : c);
      } catch { /* telemetry-exempt: not there, so not read */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

function excludePatterns(files: ParentInstructionFile[]): { patterns: string[]; unmatched: ParentInstructionFile[] } {
  const patterns: string[] = [];
  const unmatched: ParentInstructionFile[] = [];
  for (const f of files) {
    const each = [f.path, ...(f.realPath ? [f.realPath] : [])].map(literalPattern);
    if (each.some((p) => p === null)) { unmatched.push(f); continue; }
    for (const p of each as string[]) patterns.push(f.folder ? `${p}/**` : p);
  }
  return { patterns, unmatched };
}

function localSettingsPath(worktree: string, provider: OrchestratorProvider): string {
  const conv = provider.conventions;
  return path.join(worktree, conv.configDir, conv.localSettingsFile || 'settings.local.json');
}

/** The local settings file as an object; null when it exists but isn't a JSON object Clubhouse can safely add to. */
async function readLocalSettings(file: string): Promise<{ settings: Record<string, unknown>; exists: boolean } | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf-8');
  } catch {
    // telemetry-exempt: no local settings yet
    return { settings: {}, exists: false };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const settings = parsed as Record<string, unknown>;
    if (settings.claudeMdExcludes !== undefined && (!Array.isArray(settings.claudeMdExcludes) || settings.claudeMdExcludes.some((x) => typeof x !== 'string'))) return null;
    return { settings, exists: true };
  } catch {
    // telemetry-exempt: the person's file doesn't parse; it is left alone and Preview says the files are read.
    return null;
  }
}

interface ExcludesManifest {
  /** The local settings file, relative to the worktree with forward slashes. */
  settingsFile: string;
  /** The `claudeMdExcludes` entries Clubhouse added. Entries the person added aren't listed. */
  entries: string[];
  /** Clubhouse created the settings file, so it may remove it once nothing else is in it. */
  createdFile?: boolean;
}

async function readExcludesManifest(worktree: string): Promise<ExcludesManifest | null> {
  try {
    const raw = JSON.parse(await fsp.readFile(path.join(worktree, EXCLUDES_MANIFEST), 'utf-8')) as Partial<ExcludesManifest> | null;
    if (!raw || typeof raw.settingsFile !== 'string' || !Array.isArray(raw.entries)) return null;
    insideDir(worktree, raw.settingsFile);
    return {
      settingsFile: raw.settingsFile,
      entries: raw.entries.filter((x: unknown): x is string => typeof x === 'string'),
      ...(raw.createdFile === true && { createdFile: true }),
    };
  } catch {
    // telemetry-exempt: no manifest yet (or one that doesn't parse), so Clubhouse owns no entries.
    return null;
  }
}

/**
 * Make Clubhouse's `claudeMdExcludes` entries in `settingsFile` exactly
 * `wanted`: the ones it added before (per the manifest) are removed, the
 * wanted ones added, and entries the person added are never touched (D49).
 * False when the settings file isn't a JSON object Clubhouse can safely change.
 */
async function replaceClubhouseExcludes(worktree: string, settingsFile: string, wanted: string[]): Promise<boolean> {
  const manifest = await readExcludesManifest(worktree);
  const owned = manifest && manifest.settingsFile === settingsFile ? manifest.entries : [];
  const file = insideDir(worktree, settingsFile);
  const current = await readLocalSettings(file);
  if (!current) return false;
  const before = (current.settings.claudeMdExcludes as string[] | undefined) ?? [];
  const theirs = before.filter((e) => !owned.includes(e));
  const added = [...new Set(wanted.filter((p) => !theirs.includes(p)))];
  const next = [...theirs, ...added];
  const createdFile = current.exists ? (owned.length > 0 && manifest?.createdFile === true) : added.length > 0;
  if (next.length !== before.length || next.some((e, i) => e !== before[i])) {
    const settings: Record<string, unknown> = { ...current.settings };
    if (next.length > 0) settings.claudeMdExcludes = next;
    else delete settings.claudeMdExcludes;
    if (Object.keys(settings).length === 0 && createdFile) {
      await fsp.rm(file, { force: true });
    } else {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, JSON.stringify(settings, null, 2), 'utf-8');
    }
  }
  const manifestFile = path.join(worktree, EXCLUDES_MANIFEST);
  if (added.length > 0) {
    const record: ExcludesManifest = { settingsFile, entries: added, ...(createdFile && { createdFile: true }) };
    await fsp.writeFile(manifestFile, JSON.stringify(record, null, 2), 'utf-8');
  } else {
    await fsp.rm(manifestFile, { force: true });
  }
  return true;
}

/**
 * Remove the `claudeMdExcludes` entries Clubhouse added, and its manifest,
 * keeping the rest of the settings file. For unmanage, and for a start on a
 * CLI other than Claude Code.
 */
export async function removeManagedClaudeExcludes(worktree: string): Promise<void> {
  const manifest = await readExcludesManifest(worktree);
  if (!manifest) {
    await fsp.rm(path.join(worktree, EXCLUDES_MANIFEST), { force: true });
    return;
  }
  if (!(await replaceClubhouseExcludes(worktree, manifest.settingsFile, []))) {
    // The manifest stays, so a later managed start can still remove them.
    appLog('core:managed', 'warn', 'Local settings are not a JSON object; the CLAUDE.md excludes Clubhouse added were left in', { meta: { entries: manifest.entries.length } });
  }
}

/**
 * Claude Code reads CLAUDE.md files in parent folders, so the project's own
 * reaches an agent in `<project>/.clubhouse/agents/<name>`. Its
 * `claudeMdExcludes` setting turns them off (D49): the paths go into the
 * worktree's local settings, replacing the entries Clubhouse added at the
 * last start and keeping the person's. Returns the files still read.
 */
async function writeClaudeExcludes(worktree: string, provider: OrchestratorProvider): Promise<ParentInstructionFile[]> {
  const files = await parentInstructionFiles(worktree);
  const { patterns, unmatched } = excludePatterns(files);
  const settingsFile = forwardSlashes(path.relative(worktree, localSettingsPath(worktree, provider)));
  const manifest = await readExcludesManifest(worktree);
  // Entries in another settings file from an earlier start come out first.
  if (manifest && manifest.settingsFile !== settingsFile) await removeManagedClaudeExcludes(worktree);
  if (!(await replaceClubhouseExcludes(worktree, settingsFile, patterns))) {
    appLog('core:managed', 'warn', 'Local settings are not a JSON object; parent CLAUDE.md files are not excluded', { meta: { files: files.length } });
    return files;
  }
  return unmatched;
}

/** Where the CLI's instructions file is, relative to the worktree with forward slashes: Copilot's is in its config folder, the others' at the root. */
function instructionsFileRel(provider: OrchestratorProvider): string {
  const conv = provider.conventions;
  return provider.id === COPILOT_ID ? forwardSlashes(path.join(conv.configDir, conv.legacyInstructionsFile)) : conv.legacyInstructionsFile;
}

/**
 * The `.git/info/exclude` pattern that keeps the instructions file Clubhouse
 * writes out of commits (D16), or null when the worktree tracks that file:
 * excluding a tracked file does nothing. Anchored to the root, since the
 * exclude file is shared by every worktree and the main checkout, and a bare
 * name would hide every untracked file of that name at any depth. When git
 * can't say, the file is excluded, as a pattern for a tracked file is harmless.
 */
export async function instructionsExcludePattern(worktree: string, provider: OrchestratorProvider): Promise<string | null> {
  const rel = instructionsFileRel(provider);
  const listed = await trackedFiles(worktree, [rel]);
  if (listed.ok === false) {
    appLog('core:managed', 'warn', 'git could not say whether the instructions file is tracked; it is excluded', { meta: { code: listed.code } });
  } else if (listed.files.includes(rel)) {
    return null;
  }
  return `/${rel}`;
}

/** Instruction files in the worktree, other than the one Clubhouse writes, that Copilot also reads. Only the ones git tracks: Clubhouse wrote none of them. */
async function copilotRepoInstructions(worktree: string, provider: OrchestratorProvider): Promise<string[]> {
  const own = instructionsFileRel(provider);
  const listed = await trackedFiles(worktree, ['CLAUDE.md', 'AGENTS.md', '.claude/rules']);
  const tracked = listed.ok ? listed.files : [];
  return tracked.filter((f) => f !== own).sort((a, b) => a.localeCompare(b));
}

/** A parent file for showing: relative to the project when inside it, else with the home folder as ~. */
function displayPath(projectPath: string, abs: string, folder: boolean): string {
  const rel = path.relative(projectPath, abs);
  const shown = rel && !rel.startsWith('..') && !path.isAbsolute(rel)
    ? rel
    : abs.startsWith(os.homedir() + path.sep) ? `~${abs.slice(os.homedir().length)}` : abs;
  return forwardSlashes(shown) + (folder ? '/' : '');
}

/** JSON-format CLIs read MCP from a file in the worktree. TOML (Codex) gets its servers as launch flags instead. */
async function writeMcpFile(worktree: string, provider: OrchestratorProvider, servers: Record<string, McpServerDef>): Promise<void> {
  const conv = provider.conventions;
  if (conv.settingsFormat === 'toml') return;
  const file = path.join(worktree, conv.mcpConfigFile);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  // The live Clubhouse bridge is injected after this, into the same file.
  await fsp.writeFile(file, JSON.stringify({ mcpServers: servers }, null, 2), 'utf-8');
}

export interface DeliveryRecord {
  fingerprint: string;
  /** Parts the setup lists that no longer exist, skipped this start. */
  missing?: number;
  deliveredAt: string;
  orchestrator?: string;
  parts: Record<string, { name: string; revision: number }>;
  order: string[];
}

/** A stable fingerprint of what the agent gets: parts, revisions, order and launch settings. */
export function setupFingerprint(agent: DurableAgentConfig, resolved: Resolved): DeliveryRecord {
  const parts: DeliveryRecord['parts'] = {};
  for (const p of [...resolved.blocks, ...resolved.skills, ...resolved.mcps]) parts[p.id] = { name: p.name, revision: p.revision };
  const order = [...resolved.blocks.map((b) => b.id), '|', ...resolved.skills.map((s) => s.id), '|', ...resolved.mcps.map((m) => m.id)];
  const fingerprint = canonicalHash({
    parts, order,
    orchestrator: agent.orchestrator ?? null, model: agent.model ?? null,
    freeAgentMode: agent.freeAgentMode ?? null, orchestration: agent.orchestration ?? null,
  });
  return { fingerprint, deliveredAt: new Date().toISOString(), ...(agent.orchestrator && { orchestrator: agent.orchestrator }), parts, order };
}

/**
 * Write a managed agent's setup into its folder before a session starts.
 * Missing parts are skipped and logged, never fatal: a running setup is
 * better than none, and the builder shows what's missing.
 */
export async function deliverManagedSetup(params: {
  service: ManagedAgentsService;
  projectPath: string;
  agent: DurableAgentConfig;
  provider: OrchestratorProvider;
  /** Where a skill folder Clubhouse didn't write is moved before a managed one replaces it. */
  backupRoot?: string;
}): Promise<DeliveryRecord | null> {
  const { service, projectPath, agent, provider } = params;
  if (!agent.managed || !agent.worktreePath) return null;
  const resolved = await resolveSetup(service, agent.managed);
  if (resolved.missing.length > 0) {
    appLog('core:managed', 'warn', 'Managed setup lists parts that no longer exist; skipped', { meta: { agentId: agent.id, missing: resolved.missing.length } });
  }
  const dropped = [...new Set(resolved.mcps.flatMap((m) => m.droppedEnvValues))];
  if (dropped.length > 0) {
    // Names only, never values (D46).
    appLog('core:managed', 'warn', 'MCP parts were stored with env values Clubhouse no longer uses; set these in the environment', { meta: { agentId: agent.id, names: dropped } });
  }
  const instructions = await renderManagedInstructions(projectPath, agent, resolved);
  await provider.writeInstructions(agent.worktreePath, instructions);
  await writeSkills(agent.worktreePath, provider, resolved.skills, params.backupRoot);
  await writeMcpFile(agent.worktreePath, provider, mcpServersOf(resolved));
  if (provider.id === CLAUDE_CODE_ID) await writeClaudeExcludes(agent.worktreePath, provider);
  // Another CLI doesn't read them, so the entries Clubhouse added for Claude Code come out.
  else await removeManagedClaudeExcludes(agent.worktreePath);
  return { ...setupFingerprint(agent, resolved), ...(resolved.missing.length > 0 && { missing: resolved.missing.length }) };
}

/** What a quick agent gets from a template (#2893, D25). */
export interface QuickManagedLaunch {
  templateId: string;
  /** The template's blocks, joined and filled in for this quick agent. Goes in the system prompt. */
  instructions: string;
  /** The template's MCP servers, for the launch flags. The Clubhouse bridge is separate, and always added. */
  servers: Record<string, McpServerDef>;
  /** Skills in the template. Not delivered: a quick agent's folder is the project's or another agent's. */
  skippedSkills: number;
  /** Parts the template lists that no longer exist. */
  missing: number;
}

/**
 * Build a quick agent from a template. Nothing is written anywhere: a quick
 * agent runs in the project folder or a durable agent's worktree, whose
 * instruction, skill and MCP files belong to someone else. The instructions
 * reach it through the system prompt every CLI already takes, and the MCP
 * servers through the launch flags, for the CLIs that have them.
 */
export async function quickManagedLaunch(params: {
  service: ManagedAgentsService;
  projectPath: string;
  cwd: string;
  agentId: string;
  agentName: string;
  templateId: string;
  /** The branch checked out in `cwd`, when there is one. */
  branch?: string | null;
}): Promise<QuickManagedLaunch> {
  // setupFromTemplate keeps only the parts that still exist, so what it dropped
  // is what's missing: the template's own list minus what came back.
  const template = await params.service.getTemplate(params.templateId);
  const { setup: fromTemplate } = await params.service.setupFromTemplate(params.templateId);
  const setup = withWorkingIdentity(fromTemplate);
  const resolved = await resolveSetup(params.service, setup);
  const partCount = (s: { blocks: string[]; skills: string[]; mcps: string[] }) => s.blocks.length + s.skills.length + s.mcps.length;
  const dropped = partCount(template.setup) - partCount(setup);
  const agent: DurableAgentConfig = {
    id: params.agentId, name: params.agentName, color: 'gray', createdAt: new Date().toISOString(),
    worktreePath: params.cwd, ...(params.branch && { branch: params.branch }),
  };
  const composed = composeInstructions(resolved.blocks.map((b) => ({ content: b.content })));
  if (composed.ok === false) throw new Error(composed.code);
  const ctx = wildcardContextFor(params.projectPath, agent);
  const rel = path.relative(params.projectPath, params.cwd).replace(/\\/g, '/');
  ctx.agentPath = rel ? `${rel}/` : './';
  if (!params.branch) ctx.standbyBranch = 'the checked-out branch';
  return {
    templateId: params.templateId,
    instructions: replaceManagedWildcards(composed.text, ctx),
    servers: mcpServersOf(resolved),
    skippedSkills: resolved.skills.length,
    missing: dropped + resolved.missing.length,
  };
}

/** The exact result an agent gets at its next start, for the builder's Preview. */
export async function previewManagedSetup(params: {
  service: ManagedAgentsService;
  projectPath: string;
  agent: DurableAgentConfig;
  provider: OrchestratorProvider | undefined;
  setup?: ManagedAgentSetup;
}): Promise<ManagedPreview> {
  const setup = params.setup ?? params.agent.managed;
  if (!setup) return { instructions: '', blocks: [], skills: [], mcps: [], missing: [] };
  const resolved = await resolveSetup(params.service, setup);
  const instructions = await renderManagedInstructions(params.projectPath, params.agent, resolved);
  const ctx = wildcardContextFor(params.projectPath, params.agent);
  const usage = new Map<string, number>();
  for (const b of resolved.blocks) usage.set(b.id, (await params.service.consumers(b.id)).length);
  let line = 1;
  const blocks = resolved.blocks.map((b) => {
    const lines = replaceManagedWildcards(b.content, ctx).split('\n').length;
    const entry = { id: b.id, name: b.name, builtin: b.builtin, usedBy: usage.get(b.id) ?? 0, startLine: line, endLine: line + lines - 1 };
    line += lines + 1;
    return entry;
  });
  const conv = params.provider?.conventions;
  const folderRoot = conv ? skillsFolderOf(conv) : 'skills';
  const extra = await outsideTheSetup(params.projectPath, params.agent, params.provider, resolved.skills.map((s) => s.content.skillName));
  return {
    ...extra,
    instructions,
    blocks,
    skills: resolved.skills.map((s) => ({ id: s.id, name: s.name, skillName: s.content.skillName, files: s.content.files.length, folder: `${folderRoot}/${s.content.skillName}`.replace(/\\/g, '/') })),
    mcps: resolved.mcps.map((m) => ({ id: m.id, name: m.name, serverKey: m.content.serverKey, builtin: m.builtin, ...(m.droppedEnvValues.length > 0 && { droppedEnvValues: m.droppedEnvValues }) })),
    missing: resolved.missing,
  };
}

/**
 * What the CLI reads besides the setup, for Preview: skill folders git tracks
 * (Clubhouse can't move them), parent CLAUDE.md files Claude Code is told
 * not to read, and other instruction files the CLI reads anyway.
 */
type OutsideTheSetup = Pick<ManagedPreview, 'repoSkills' | 'keptSkills' | 'keptSkillsReason' | 'notRead' | 'alsoRead' | 'cliName'>;

async function outsideTheSetup(projectPath: string, agent: DurableAgentConfig, provider: OrchestratorProvider | undefined, skillNames: string[]): Promise<OutsideTheSetup> {
  const worktree = agent.worktreePath;
  if (!worktree || !provider) return {};
  const conv = provider.conventions;
  const folderRoot = skillsFolderOf(conv);
  const { tracked, kept, keptReason } = await otherSkillFolders(worktree, provider, skillNames);
  const out: OutsideTheSetup = { cliName: provider.displayName };
  if (tracked.length > 0) out.repoSkills = tracked.map((n) => `${folderRoot}/${n}`);
  if (kept.length > 0 && keptReason) {
    out.keptSkills = kept.map((n) => `${folderRoot}/${n}`);
    out.keptSkillsReason = keptReason;
  }
  if (provider.id === CLAUDE_CODE_ID) {
    const files = await parentInstructionFiles(worktree);
    const settings = await readLocalSettings(localSettingsPath(worktree, provider));
    const { unmatched } = excludePatterns(files);
    const read = settings ? unmatched : files;
    const excluded = files.filter((f) => !read.includes(f));
    if (excluded.length > 0) out.notRead = excluded.map((f) => displayPath(projectPath, f.path, f.folder));
    if (read.length > 0) out.alsoRead = read.map((f) => displayPath(projectPath, f.path, f.folder));
  } else if (provider.id === COPILOT_ID) {
    const read = await copilotRepoInstructions(worktree, provider);
    if (read.length > 0) out.alsoRead = read;
  }
  return out;
}

export type { Resolved as ResolvedManagedSetup };
export { resolveSetup as resolveManagedSetup };
