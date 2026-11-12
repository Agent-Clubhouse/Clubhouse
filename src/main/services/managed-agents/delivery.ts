/**
 * Delivery for Clubhouse-managed agents (#2896). At each session start the
 * agent gets exactly its setup: its instruction blocks joined in order, its
 * skills copied into its own folder, and its MCP servers. The prepare-handoff
 * skill is additionally gated by the runtime feature and offer permission.
 * Clubhouse adds no instruction text of its own.
 *
 * Works for every CLI and both runtimes because it writes where each CLI
 * already reads (the provider's instructions file, skills folder and MCP
 * file) and hands the MCP servers to the existing launch merge points.
 */
import { agentAccess } from '../free-agent-settings';
import { resolveRuntimeMode } from '../chat-runtime-settings';
import { accessLevelsFor, isAccessLevel, startableAccess } from '../../../shared/agent-access';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { composeInstructions } from '../asset-catalog/composer';
import { canonicalHash } from '../asset-catalog/planner';
import { replaceManagedWildcards } from '../../../shared/wildcard-replacer';
import { buildWildcardContext } from '../agent-wildcards';
import { appLog } from '../log-service';
import { MAX_QUICK_RUN_CHANGES, type DurableAgentConfig, type McpServerDef, type QuickRunChanges } from '../../../shared/types';
import type { OrchestratorProvider } from '../../orchestrators/types';
import {
  CLUBHOUSE_MCP_PART_ID,
  type ManagedAgentSetup,
  type ManagedMcpContent,
  type ManagedPreview,
  type ManagedRunningSnapshot,
  type ManagedSettingsRow,
  type ManagedSkillContent,
} from '../../../shared/managed-agents-types';
import { managedSettingsSummary } from '../../../shared/managed-settings-summary';
import { resolveOrchestrationPolicy } from '../../../shared/orchestration-policy';
import { builtinPart, ManagedError, withClubhouseSetup, type ManagedAgentsService } from './service';
import { BUILTIN_BLOCK_IDS, withWorkingIdentity } from './builtins';
import { MANAGED_SKILLS_MANIFEST, skillsFolderOf } from '../../../shared/skills-folder';
import { helperTemplateFor } from './helpers';
import { canPrepareHandoff, PREPARE_HANDOFF_SKILL } from './handoff-skill';

/** Written beside the managed skills so a later start removes only what Clubhouse put there. */
export const SKILLS_MANIFEST = MANAGED_SKILLS_MANIFEST;
/** In the worktree: the `claudeMdExcludes` entries Clubhouse added, so it replaces only those (D49). Git-excluded. */
export const EXCLUDES_MANIFEST = '.clubhouse-managed-excludes.json';

interface Resolved {
  blocks: Array<{ id: string; name: string; builtin: boolean; revision: number; content: string }>;
  /** `retiredCopy`: the person's copy of a retired built-in (D99), which a project's own folder still wins over (D74). */
  skills: Array<{ id: string; name: string; revision: number; builtin: boolean; retiredCopy?: true; content: ManagedSkillContent }>;
  /** `droppedEnvValues`: env names the part stored literal values for, which now come from the environment (D46). */
  mcps: Array<{ id: string; name: string; revision: number; builtin: boolean; content: ManagedMcpContent; droppedEnvValues: string[] }>;
  missing: string[];
}

async function resolveSetup(service: ManagedAgentsService, saved: ManagedAgentSetup, agentId?: string): Promise<Resolved> {
  // Both sides of the delivery fingerprint (delivered and current) resolve here,
  // so a setup saved before the Clubhouse part was required fingerprints the same.
  const setup = withClubhouseSetup(saved);
  const out: Resolved = { blocks: [], skills: [], mcps: [], missing: [] };
  const handoff = canPrepareHandoff(agentId);
  for (const id of setup.blocks) {
    const head = await service.headContent(id);
    if (!head || head.content.kind !== 'block') { out.missing.push(id); continue; }
    out.blocks.push({ id, name: head.entry.name, builtin: head.entry.source.kind === 'builtin', revision: head.entry.headRevision, content: head.content.content });
  }
  for (const id of setup.skills) {
    if (id === PREPARE_HANDOFF_SKILL.id && !handoff) continue;
    const head = await service.headContent(id);
    if (!head || head.content.kind !== 'skill') { out.missing.push(id); continue; }
    out.skills.push({ id, name: head.entry.name, revision: head.entry.headRevision, builtin: head.entry.source.kind === 'builtin', ...(head.fromRetiredBuiltin && { retiredCopy: true as const }), content: head.content });
  }
  if (handoff && !out.skills.some((skill) => skill.content.skillName === PREPARE_HANDOFF_SKILL.skillName)) {
    const head = await service.headContent(PREPARE_HANDOFF_SKILL.id);
    if (!head || head.content.kind !== 'skill') out.missing.push(PREPARE_HANDOFF_SKILL.id);
    else out.skills.push({
      id: PREPARE_HANDOFF_SKILL.id, name: head.entry.name, revision: head.entry.headRevision, builtin: true, content: head.content,
    });
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

/** The blocks joined in order, wildcards as written. */
function composeManagedText(resolved: Resolved): string {
  const composed = composeInstructions(resolved.blocks.map((b) => ({ content: b.content })));
  if (composed.ok === false) throw new Error(composed.code);
  return composed.text;
}

/** What the setup renders to, with wildcards filled in for this agent. */
export async function renderManagedInstructions(projectPath: string, agent: DurableAgentConfig, resolved: Resolved): Promise<string> {
  return replaceManagedWildcards(composeManagedText(resolved), wildcardContextFor(projectPath, agent));
}

/**
 * Preview's settings summary for an agent: CLI, model, effort, Access,
 * orchestration and helpers. The helper template is named only when
 * it orchestrates; a template that can't be read is left out.
 */
export async function managedSettingsRows(service: ManagedAgentsService, agent: DurableAgentConfig, provider: OrchestratorProvider | undefined, projectPath?: string): Promise<ManagedSettingsRow[]> {
  const helper = !!agent.parentAgentId;
  let helperTemplateName: string | undefined;
  if (resolveOrchestrationPolicy(agent.orchestration, { helper }).orchestrate) {
    try {
      const { templateId } = await helperTemplateFor(service, agent.helperTemplateId);
      helperTemplateName = (await service.getTemplate(templateId)).name;
    } catch {
      // telemetry-exempt: the summary leaves the helper template out.
    }
  }
  // The level the start uses (#3004), as the spawn does: in the terminal the nearest lower level its
  // CLI has a start flag for; in chat the driver's (one without the level asks first). A record saved
  // before #2761 starts as it always did, so it gets no note.
  const access = agentAccess(agent, projectPath);
  const runtime = provider && isAccessLevel(agent.access) ? resolveRuntimeMode(provider.id, agent.runtimeMode ?? undefined).mode : undefined;
  const startsAt = !provider || !runtime ? access
    : runtime === 'terminal' ? startableAccess(access, provider.id, 'terminal')
      : accessLevelsFor(provider.id, 'chat').includes(access) ? access : 'ask';
  return managedSettingsSummary({
    cliName: provider?.displayName ?? agent.orchestrator,
    model: agent.model,
    effort: agent.effort,
    access,
    ...(startsAt !== access && { accessStartsAt: { level: startsAt, runtime: runtime! } }),
    orchestration: agent.orchestration,
    helperTemplateName,
    helper,
  });
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
  return mcpServersOf(await resolveSetup(service, agent.managed, agent.id));
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
    // One the project has since committed is the project's now; when git can't say, nothing goes.
    const tracked = await trackedFiles(worktree, [rel.replace(/\\/g, '/')]);
    if (tracked.ok === false) {
      appLog('core:managed', 'warn', 'git could not list tracked skill folders; the previous folder\'s managed skills were left in place', { meta: { code: tracked.code } });
      continue;
    }
    const committed = new Set(tracked.files.map((f) => f.slice(rel.length + 1).split('/')[0].toLowerCase()));
    for (const name of listed) {
      // Only a plain folder name in the manifest: never the folder itself or anything outside it.
      if (!name || name !== path.basename(name) || name === '.' || name === '..') continue;
      if (committed.has(name.toLowerCase())) continue;
      await fsp.rm(insideDir(root, name), { recursive: true, force: true });
    }
    await fsp.rm(path.join(root, SKILLS_MANIFEST), { force: true });
  }
}

/**
 * Exactly what Clubhouse wrote into skills folders, as anchored exclude
 * patterns: each delivered skill folder and the manifest, in the current
 * skills folder and any the provider used before (until that folder's
 * cleanup has removed its manifest). Read from each worktree's manifests,
 * since `.git/info/exclude` covers the main checkout and every worktree: a
 * whole-folder pattern would hide the person's own skills there (D73).
 */
export async function managedSkillExcludes(worktrees: string[], provider: OrchestratorProvider): Promise<string[]> {
  const roots = [skillsFolderOf(provider.conventions), ...(provider.conventions.previousSkillsRoots ?? [])];
  const out = new Set<string>();
  for (const worktree of new Set(worktrees)) {
    for (const rel of roots) {
      const root = path.join(worktree, rel);
      let names: string[];
      try {
        const raw = JSON.parse(await fsp.readFile(path.join(root, SKILLS_MANIFEST), 'utf-8'));
        names = Array.isArray(raw?.skills) ? raw.skills.filter((x: unknown): x is string => typeof x === 'string') : [];
      } catch { continue; /* telemetry-exempt: Clubhouse wrote nothing here */ }
      out.add(`/${rel}/${SKILLS_MANIFEST}`);
      for (const name of names) {
        // A plain folder name only, so a pattern can't reach past the skill.
        if (name && name === path.basename(name) && name !== '.' && name !== '..' && !/[*?[\]!#\\]/.test(name)) out.add(`/${rel}/${name}/`);
      }
    }
  }
  return [...out].sort();
}

/** The skill folders a previous delivery wrote here, from its manifest. */
async function deliveredBefore(root: string): Promise<string[]> {
  try {
    const raw = JSON.parse(await fsp.readFile(path.join(root, SKILLS_MANIFEST), 'utf-8'));
    // Only plain folder names: never the folder itself or anything outside it, so a stray "." can't remove every skill (#3101).
    if (Array.isArray(raw?.skills)) return raw.skills.filter((x: unknown): x is string => typeof x === 'string' && !!x && x === path.basename(x) && x !== '.' && x !== '..');
  } catch { /* telemetry-exempt: first managed start, or the manifest was removed */ }
  return [];
}

type TrackedSkillFolders = { ok: true; names: Set<string> } | { ok: false; code: string };

/** The top-level folders git tracks in the agent's skills folder, lowercased (file systems may ignore case). */
async function trackedSkillFolders(worktree: string, provider: OrchestratorProvider): Promise<TrackedSkillFolders> {
  const rel = skillsFolderOf(provider.conventions);
  const listed = await trackedFiles(worktree, [rel]);
  if (listed.ok === false) return listed;
  return { ok: true, names: new Set(listed.files.filter((f) => f.startsWith(`${rel}/`)).map((f) => f.slice(rel.length + 1).split('/')[0].toLowerCase())) };
}

/**
 * Built-in skills the project has its own copy of (D74): git tracks a folder
 * by that name in the agent's skills folder. Clubhouse leaves it in place and
 * doesn't deliver the built-in, so the CLI loads the project's. Names match
 * ignoring case, since macOS and Windows file systems do: a tracked `Build/`
 * is the project's `build` skill. When git can't say, a folder on disk that
 * Clubhouse didn't write counts as the project's too, so nothing tracked is
 * ever overwritten. Custom skills aren't checked: they replace the folder as
 * before (D48), except the copy of a retired built-in (D99), which takes the
 * built-in's place here too, so it delivers exactly what the built-in did.
 * Returns the setup's folder names that are the project's.
 */
async function projectOwnSkills(worktree: string, provider: OrchestratorProvider, skills: Resolved['skills'], previous: string[], tracked?: TrackedSkillFolders): Promise<Set<string>> {
  const builtins = skills.filter((s) => s.builtin || s.retiredCopy).map((s) => s.content.skillName);
  if (builtins.length === 0) return new Set();
  const rel = skillsFolderOf(provider.conventions);
  const known = tracked ?? await trackedSkillFolders(worktree, provider);
  if (known.ok === true) return new Set(builtins.filter((n) => known.names.has(n.toLowerCase())));
  appLog('core:managed', 'warn', 'git could not list tracked skill folders; built-in skills in the way were left in place', { meta: { code: known.code } });
  let onDisk: string[] = [];
  try {
    onDisk = (await fsp.readdir(path.join(worktree, rel), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name.toLowerCase());
  } catch { /* telemetry-exempt: no skills folder, so nothing is in the way */ }
  const wrote = new Set(previous.map((n) => n.toLowerCase()));
  return new Set(builtins.filter((n) => onDisk.includes(n.toLowerCase()) && !wrote.has(n.toLowerCase())));
}

/** The note for a built-in skill the project's own copy replaces (D74). */
export function projectOwnSkillNote(folder: string): string {
  return `Using the project's own ${folder} skill`;
}

/** Writes the setup's skills; returns the built-in skill folders left to the project's own copy (D74). */
async function writeSkills(worktree: string, provider: OrchestratorProvider, skills: Resolved['skills'], backupRoot?: string): Promise<string[]> {
  await removePreviousManagedSkills(worktree, provider);
  const conv = provider.conventions;
  const root = path.join(worktree, skillsFolderOf(conv));
  await fsp.mkdir(root, { recursive: true });
  // A linked skills folder (or .claude) leads outside the agent's folder: nothing is moved out of it (D48).
  const safeToMove = await insideWithoutLinks(worktree, root);
  const previous = await deliveredBefore(root);
  const tracked = await trackedSkillFolders(worktree, provider);
  // Never written, recorded or cleaned up: the folder is the project's (D74).
  const projectOwn = await projectOwnSkills(worktree, provider, skills, previous, tracked);
  const delivered = skills.filter((s) => !projectOwn.has(s.content.skillName));
  const current = delivered.map((s) => s.content.skillName);
  for (const name of previous) {
    if (current.includes(name) || projectOwn.has(name)) continue;
    // One Clubhouse wrote that the project has since committed is the project's now; when git can't say, it stays.
    if (tracked.ok === false || tracked.names.has(name.toLowerCase())) continue;
    await fsp.rm(insideDir(root, name), { recursive: true, force: true });
  }
  for (const skill of delivered) {
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
    const other = await otherSkillFolders(worktree, provider, [...current, ...projectOwn]);
    if (other.keptReason === 'link') {
      appLog('core:managed', 'warn', 'The skills folder is a link; no skill folders were moved', { meta: { folders: other.kept.length } });
    } else if (other.keptReason === 'git') {
      appLog('core:managed', 'warn', 'git could not list tracked skill folders; none were moved', { meta: { code: other.gitErrorCode } });
    }
    for (const name of other.untracked) await moveAside(insideDir(root, name), backupRoot);
  }
  return [...projectOwn];
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
export function instructionsFileRel(provider: OrchestratorProvider): string {
  const conv = provider.conventions;
  return provider.id === COPILOT_ID ? forwardSlashes(path.join(conv.configDir, conv.legacyInstructionsFile)) : conv.legacyInstructionsFile;
}

/**
 * The root files Clubhouse delivers for a CLI, relative to the worktree with
 * forward slashes: the instructions file, the MCP file for a JSON-format CLI
 * (Codex gets its servers as launch flags), and Claude Code's local settings,
 * which hold the `claudeMdExcludes` entries (D49).
 */
export function rootFileCandidates(provider: OrchestratorProvider): string[] {
  const conv = provider.conventions;
  const rels = [instructionsFileRel(provider)];
  if (conv.settingsFormat !== 'toml') rels.push(forwardSlashes(conv.mcpConfigFile));
  if (provider.id === CLAUDE_CODE_ID) rels.push(forwardSlashes(path.join(conv.configDir, conv.localSettingsFile)));
  return rels;
}

/**
 * The `.git/info/exclude` patterns that keep the root files Clubhouse
 * delivers out of commits (D97), leaving out any the worktree tracks:
 * excluding a tracked file does nothing. Anchored to the root, since the
 * exclude file is shared by every worktree and the main checkout, and a bare
 * name would hide every untracked file of that name at any depth. When git
 * can't say, all of them are listed, as a pattern for a tracked file is harmless.
 */
export async function rootFileExcludes(worktree: string, provider: OrchestratorProvider): Promise<string[]> {
  const rels = rootFileCandidates(provider);
  const listed = await trackedFiles(worktree, rels);
  if (listed.ok === false) {
    appLog('core:managed', 'warn', 'git could not say whether the delivered root files are tracked; they are excluded', { meta: { code: listed.code } });
    return rels.map((r) => `/${r}`);
  }
  return rels.filter((r) => !listed.files.includes(r)).map((r) => `/${r}`);
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
  /** What the session started with, for Preview's "Running now" (D9). Set by a delivery, not by a fingerprint of the current setup. */
  snapshot?: Omit<ManagedRunningSnapshot, 'changes'>;
  /** Parts the setup lists that no longer exist, skipped this start. */
  missing?: number;
  deliveredAt: string;
  orchestrator?: string;
  parts: Record<string, { name: string; revision: number }>;
  order: string[];
  /** The launch settings the session started with, to name which one changed. */
  launch?: LaunchSettings;
}

/** Settings only a start delivers: launch flags, or the chat session's options. */
interface LaunchSettings {
  model: string | null;
  effort: string | null;
  access: string | null;
  freeAgentMode: boolean | null;
}

/**
 * A stable fingerprint of what a session gets only when it starts: parts,
 * revisions, order, the CLI and the launch settings. Orchestration is left
 * out: the gate and the helper tools read it live (#3197).
 */
export function setupFingerprint(agent: DurableAgentConfig, resolved: Resolved): DeliveryRecord {
  const parts: DeliveryRecord['parts'] = {};
  for (const p of [...resolved.blocks, ...resolved.skills, ...resolved.mcps]) parts[p.id] = { name: p.name, revision: p.revision };
  const order = [...resolved.blocks.map((b) => b.id), '|', ...resolved.skills.map((s) => s.id), '|', ...resolved.mcps.map((m) => m.id)];
  const launch: LaunchSettings = {
    model: agent.model ?? null, effort: agent.effort ?? null,
    // Access (#2761). Ask first and unset start the same way.
    access: agent.access !== undefined && agent.access !== 'ask' ? agent.access : null,
    freeAgentMode: agent.freeAgentMode ?? null,
  };
  const fingerprint = canonicalHash({ parts, order, orchestrator: agent.orchestrator ?? null, ...launch });
  return { fingerprint, deliveredAt: new Date().toISOString(), ...(agent.orchestrator && { orchestrator: agent.orchestrator }), parts, order, launch };
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
  const resolved = await resolveSetup(service, agent.managed, agent.id);
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
  const projectOwn = await writeSkills(agent.worktreePath, provider, resolved.skills, params.backupRoot);
  for (const folder of projectOwn) {
    // A built-in skill folder name, never project content.
    appLog('core:managed', 'info', `${projectOwnSkillNote(folder)}; its built-in isn't delivered`, { meta: { agentId: agent.id, folder } });
  }
  await writeMcpFile(agent.worktreePath, provider, mcpServersOf(resolved));
  if (provider.id === CLAUDE_CODE_ID) await writeClaudeExcludes(agent.worktreePath, provider);
  // Another CLI doesn't read them, so the entries Clubhouse added for Claude Code come out.
  else await removeManagedClaudeExcludes(agent.worktreePath);
  const record = setupFingerprint(agent, resolved);
  return {
    ...record,
    snapshot: {
      deliveredAt: record.deliveredAt,
      instructions,
      rawInstructions: composeManagedText(resolved),
      skills: resolved.skills.map((sk) => sk.name),
      mcps: resolved.mcps.map((m) => m.name),
      settings: await managedSettingsRows(service, agent, provider, params.projectPath),
    },
    ...(resolved.missing.length > 0 && { missing: resolved.missing.length }),
  };
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
  /** What this launch added to or left out of the template (#2928). Empty lists when it changed nothing. */
  changes: QuickRunChanges;
}

/**
 * A quick launch's setup: the template's, as a quick agent gets it (the
 * working Identity), with this launch's parts added and left out (#2928,
 * D102). Only parts a person could put in a setup themselves: library parts
 * that exist and aren't retired, never the Clubhouse MCP part left out, and
 * the result passes the checks a saved setup does. No skill is added (a quick
 * agent gets none) and no MCP server for a CLI that takes none at launch.
 * Leaving out a part the template no longer has is nothing to do. Throws
 * before anything starts. The template is only read.
 */
export async function quickRunSetup(
  service: ManagedAgentsService,
  working: { blocks: string[]; skills: string[]; mcps: string[] },
  choice: { addParts?: string[]; removeParts?: string[] },
  opts: { mcpLaunchFlags?: boolean } = {},
): Promise<{ setup: { blocks: string[]; skills: string[]; mcps: string[] }; changes: QuickRunChanges }> {
  const add = choice.addParts ?? [];
  const remove = choice.removeParts ?? [];
  if (add.length === 0 && remove.length === 0) return { setup: working, changes: { added: [], removed: [] } };
  if (add.length > MAX_QUICK_RUN_CHANGES || remove.length > MAX_QUICK_RUN_CHANGES) {
    throw new ManagedError('invalid', `A quick launch adds or leaves out at most ${MAX_QUICK_RUN_CHANGES} parts.`);
  }
  const live = await service.liveEntries();
  // Either Identity id names the one the quick agent gets.
  const asWorking = (id: string) => (id === BUILTIN_BLOCK_IDS.identity ? BUILTIN_BLOCK_IDS.identityHelper : id);
  const inTemplate = new Set([...working.blocks, ...working.skills, ...working.mcps]);
  if (remove.map(asWorking).includes(CLUBHOUSE_MCP_PART_ID)) throw new ManagedError('invalid', 'The Clubhouse MCP part stays in every setup.');
  // A part the template no longer has (deleted, or taken out since the form opened) is already left out.
  const drop = new Set(remove.map(asWorking).filter((id) => inTemplate.has(id)));
  const setup = {
    blocks: working.blocks.filter((id) => !drop.has(id)),
    skills: working.skills.filter((id) => !drop.has(id)),
    mcps: working.mcps.filter((id) => !drop.has(id)),
  };
  const added: string[] = [];
  for (const raw of add) {
    const id = asWorking(raw);
    const entry = live[id];
    // What a person can add to a setup: a part in the library, not one an app update retired.
    if (!entry || entry.owner.kind !== 'library' || builtinPart(id)?.retired) throw new ManagedError('not_found', 'A part to add isn\'t in the library.');
    if (entry.kind === 'skill') throw new ManagedError('invalid', 'A quick agent gets no skills, since it has no folder of its own.');
    if (entry.kind === 'mcp' && opts.mcpLaunchFlags === false) throw new ManagedError('invalid', 'This CLI reads MCP servers only from the folder\'s own MCP file, so a quick agent can\'t get one added.');
    const list = entry.kind === 'block' ? setup.blocks : entry.kind === 'mcp' ? setup.mcps : null;
    if (!list) throw new ManagedError('not_found', 'A part to add isn\'t in the library.');
    if (!list.includes(id)) list.push(id);
    if ((!inTemplate.has(id) || drop.has(id)) && !added.includes(id)) added.push(id);
  }
  // Left out and added back is no change either way.
  const changes = { added: added.filter((id) => !drop.has(id)), removed: [...drop].filter((id) => !added.includes(id)) };
  // The checks a saved setup passes (parts that exist), so a launch can't do what a save couldn't. Skills
  // aren't checked: a quick agent gets none, and the launch without changes doesn't check them either.
  const checked = await service.checkSetup({ ...setup, skills: [] });
  return { setup: { blocks: checked.blocks, skills: setup.skills, mcps: checked.mcps }, changes };
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
  /** This launch's part changes (#2928). */
  addParts?: string[];
  removeParts?: string[];
  /** The CLI takes MCP servers at launch. False: none can be added. */
  mcpLaunchFlags?: boolean;
}): Promise<QuickManagedLaunch> {
  // setupFromTemplate keeps only the parts that still exist, so what it dropped
  // is what's missing: the template's own list minus what came back.
  const template = await params.service.getTemplate(params.templateId);
  const { setup: fromTemplate } = await params.service.setupFromTemplate(params.templateId);
  const { setup, changes } = await quickRunSetup(params.service, withWorkingIdentity(fromTemplate), params, { mcpLaunchFlags: params.mcpLaunchFlags });
  const resolved = await resolveSetup(params.service, { version: 1, ...setup });
  const partCount = (s: { blocks: string[]; skills: string[]; mcps: string[] }) => s.blocks.length + s.skills.length + s.mcps.length;
  const dropped = partCount(template.setup) - partCount(fromTemplate);
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
    changes,
  };
}

/** The exact result an agent gets at its next start, for the builder's Preview. */
export async function previewManagedSetup(params: {
  service: ManagedAgentsService;
  projectPath: string;
  agent: DurableAgentConfig;
  provider: OrchestratorProvider | undefined;
  setup?: ManagedAgentSetup;
  /**
   * An agent with no folder yet (a New agent draft): the checkout its worktree
   * will come from, so Preview can say which built-in skills the project's
   * own committed copy replaces.
   */
  projectOwnFrom?: string;
}): Promise<ManagedPreview> {
  const setup = params.setup ?? params.agent.managed;
  if (!setup) return { instructions: '', blocks: [], skills: [], mcps: [], missing: [] };
  const resolved = await resolveSetup(params.service, setup, params.agent.id);
  const rawInstructions = composeManagedText(resolved);
  // The same render delivery writes, so Preview matches the file byte for byte.
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
  const worktree = params.agent.worktreePath;
  const projectOwn = worktree && params.provider
    ? await projectOwnSkills(worktree, params.provider, resolved.skills, await deliveredBefore(path.join(worktree, skillsFolderOf(params.provider.conventions))))
    // Clubhouse never delivers into the project's checkout, so nothing there is its own.
    : params.projectOwnFrom && params.provider
      ? await projectOwnSkills(params.projectOwnFrom, params.provider, resolved.skills, [])
      : new Set<string>();
  return {
    ...extra,
    instructions,
    rawInstructions,
    settings: await managedSettingsRows(params.service, params.agent, params.provider, params.projectPath),
    blocks,
    skills: resolved.skills.map((s) => ({
      id: s.id, name: s.name, skillName: s.content.skillName, files: s.content.files.length, folder: `${folderRoot}/${s.content.skillName}`.replace(/\\/g, '/'),
      ...(projectOwn.has(s.content.skillName) && { projectOwn: projectOwnSkillNote(s.content.skillName) }),
    })),
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
