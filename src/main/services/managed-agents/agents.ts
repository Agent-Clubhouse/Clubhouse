/**
 * Agent-level managed operations (#2893): create a managed agent, preview
 * and switch an existing one to managed, and apply a template's settings.
 * They combine the managed-agents service with agent config and
 * orchestration policy.
 */
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as agentConfig from '../agent-config';
import {
  carryPersonaOrchestration,
  reconcileAfterPersonaChange,
  restorePersonaOrchestration,
  setOrchestrationPolicy,
  type CarriedPersonaOrchestration,
} from '../orchestration-policy';
import { resolveOrchestrator } from '../agent-system';
import { isClubhouseModeEnabled } from '../clubhouse-mode-settings';
import { materializedDefaults, materializedInstructions, type MaterializedDefaults } from '../materialization-service';
import type { DurableAgentConfig } from '../../../shared/types';
import type {
  ManagedAgentSetup,
  ManagedConvertPreview,
  ManagedMcpContent,
  ManagedPartContent,
  ManagedSkillContent,
  ManagedTemplateSettings,
} from '../../../shared/managed-agents-types';
import type { ValidationIssue } from '../../../shared/asset-catalog-types';
import type { OrchestratorProvider } from '../../orchestrators/types';
import { readLocalMcpJson } from '../agent-settings-service';
import { adoptNativeMcpServer, MAX_SKILL_BUNDLE_BYTES, MAX_SKILL_FILES, validatePayload } from '../asset-catalog/validation';
import { CLUBHOUSE_MCP_PART_ID } from '../../../shared/managed-agents-types';
import { managedAgents } from './index';
import { BUILTIN_BLOCK_IDS } from './builtins';
import { ManagedError } from './service';
import { backupInstructions, clearAwaitingFirstStart, markAwaitingFirstStart } from './before-managed';
import { backupMcpFile, hasMcpFileToKeep, MCP_BACKUP_DIR, mcpBackupPath } from './mcp-backup';
import { appLog } from '../log-service';

export interface CreateManagedAgentInput {
  name: string;
  color: string;
  /** Start from this template. Omit to build from scratch. */
  templateId?: string;
  /** The setup to save. When a template is given too, this replaces the template's parts. */
  setup?: Omit<ManagedAgentSetup, 'version'>;
  /** Settings over the template's. */
  settings?: ManagedTemplateSettings;
}

/** Apply settings a template or the builder carries. Unset fields are left alone. */
export async function applyManagedSettings(projectPath: string, agentId: string, settings: ManagedTemplateSettings): Promise<void> {
  const updates: Parameters<typeof agentConfig.updateDurableConfig>[2] = {};
  if (settings.orchestrator !== undefined) updates.orchestrator = settings.orchestrator;
  if (settings.model !== undefined) updates.model = settings.model;
  if (settings.freeAgentMode !== undefined) updates.freeAgentMode = settings.freeAgentMode;
  if (Object.keys(updates).length > 0) await agentConfig.updateDurableConfig(projectPath, agentId, updates);
  if (settings.orchestration && Object.keys(settings.orchestration).length > 0) {
    const result = await setOrchestrationPolicy(projectPath, agentId, settings.orchestration);
    if (!result.ok) throw new ManagedError('invalid', result.message);
  }
}

export async function createManagedAgent(projectPath: string, input: CreateManagedAgentInput): Promise<DurableAgentConfig> {
  const service = managedAgents();
  const base = input.templateId ? await service.setupFromTemplate(input.templateId) : null;
  const settings: ManagedTemplateSettings = { ...(base?.settings ?? {}), ...(input.settings ?? {}) };
  if (base?.settings.orchestration || input.settings?.orchestration) {
    settings.orchestration = { ...(base?.settings.orchestration ?? {}), ...(input.settings?.orchestration ?? {}) };
  }
  const setup: Omit<ManagedAgentSetup, 'version'> = input.setup
    ? { ...input.setup, ...(input.templateId && { templateId: input.templateId }) }
    : base?.setup ?? { blocks: [BUILTIN_BLOCK_IDS.identity], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID] };
  // Managed agents always get their own folder: a worktree in a git project, a plain folder otherwise.
  const config = await agentConfig.createDurable(projectPath, input.name, input.color, settings.model, true, settings.orchestrator, settings.freeAgentMode);
  try {
    await service.saveSetup(projectPath, config.id, setup);
    if (settings.orchestration && Object.keys(settings.orchestration).length > 0) {
      await applyManagedSettings(projectPath, config.id, { orchestration: settings.orchestration });
    }
  } catch (err) {
    // Leave no half-made agent: it has no setup, so remove it.
    await agentConfig.deleteUnregister(projectPath, config.id).catch(() => {});
    throw err;
  }
  return (await agentConfig.getDurableConfig(projectPath, config.id)) ?? config;
}

// ── Switching an existing agent to managed ─────────────────────────────

type PartSource = 'folder' | 'project';

interface ConvertPlan {
  /** What the block holds: the instructions file, or for a Clubhouse Mode agent what Clubhouse Mode would write. Empty when there is none. */
  instructions: string;
  /** The instructions file in the agent's folder as it is now, for the backup. */
  onDisk: string;
  /** Whether the instructions become a block. False when there are none, or the catalog would refuse them. */
  keepInstructions: boolean;
  /** The block the instructions become. */
  blockName: string;
  /** `from` is `project` for a project default Clubhouse Mode would deliver, else the agent's folder. */
  skills: Array<{ folder: string; from: PartSource; content: ManagedSkillContent }>;
  mcps: Array<{ serverKey: string; from: PartSource; content: ManagedMcpContent }>;
  notes: string[];
}

/** Why the catalog refuses a skill or MCP server, in words. */
function refusal(issues: ValidationIssue[]): string {
  const codes = new Set(issues.map((i) => i.code));
  if (codes.has('secret_value')) return 'it holds a secret value, and Clubhouse stores no secrets';
  if (codes.has('credential_file')) return 'it contains a credentials file (such as .env or a key file), and Clubhouse stores no secrets';
  if (codes.has('launch_settings_in_instruction')) return 'its front matter sets a model or CLI, which belong in the agent\'s settings';
  if (codes.has('missing_skill_entrypoint')) return 'it has no SKILL.md';
  if (codes.has('too_large')) return 'it is too large';
  if (codes.has('reserved_namespace')) return 'its name is reserved for Clubhouse';
  if (codes.has('unsupported_native_field')) return 'it uses settings Clubhouse can\'t keep';
  return 'Clubhouse can\'t read it';
}

/** A skill folder as catalog files: text as UTF-8, anything else base64, scripts marked executable. */
async function readSkillFolder(dir: string): Promise<{ files: ManagedSkillContent['files'] } | { problem: string }> {
  const files: ManagedSkillContent['files'] = [];
  let total = 0;
  const walk = async (rel: string): Promise<string | null> => {
    const entries = await fsp.readdir(path.join(dir, rel), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) return 'it contains a symbolic link';
      if (entry.isDirectory()) {
        const nested = await walk(relPath);
        if (nested) return nested;
        continue;
      }
      if (!entry.isFile()) continue;
      const full = path.join(dir, relPath);
      const buf = await fsp.readFile(full);
      total += buf.length;
      if (files.length >= MAX_SKILL_FILES || total > MAX_SKILL_BUNDLE_BYTES) return 'it is too large';
      const text = !buf.subarray(0, 8000).includes(0) && Buffer.from(buf.toString('utf8'), 'utf8').equals(buf);
      const executable = process.platform !== 'win32' && ((await fsp.stat(full)).mode & 0o111) !== 0;
      files.push({
        path: relPath,
        content: text ? buf.toString('utf8') : buf.toString('base64'),
        ...(!text && { encoding: 'base64' as const }),
        ...(executable && { executable: true }),
      });
    }
    return null;
  };
  try {
    const problem = await walk('');
    return problem ? { problem } : { files };
  } catch {
    // telemetry-exempt: the folder becomes a note in the preview.
    return { problem: 'Clubhouse can\'t read it' };
  }
}

/**
 * What Keep makes of the agent's current files: its instructions file as a
 * block, each skill folder in its worktree and each MCP server in its MCP
 * file as custom parts for this agent only. Reads only; writes nothing.
 */
async function readInstructionsOf(provider: OrchestratorProvider, worktreePath: string): Promise<string> {
  try {
    return await provider.readInstructions(worktreePath);
  } catch {
    // telemetry-exempt: no instructions file yet
    return '';
  }
}

/** Whether Clubhouse Mode writes this agent's files at each wake. */
function usesClubhouseMode(projectPath: string, agent: DurableAgentConfig): boolean {
  return !agent.managed && !agent.clubhouseModeOverride && isClubhouseModeEnabled(projectPath);
}

/** The wildcards a managed start fills in; any other `@@` token stays as written (#2901). */
const MANAGED_WILDCARDS = new Set(['AgentName', 'StandbyBranch', 'Path', 'SourceControlProvider', 'BuildCommand', 'TestCommand', 'LintCommand']);

/** `@@` tokens in a block that a managed start leaves as they are, such as @@Persona, @@Mission and @@If. */
export function leftoverWildcards(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/@@([A-Za-z]+)/g)) if (!MANAGED_WILDCARDS.has(m[1])) found.add(`@@${m[1]}`);
  return [...found];
}

/**
 * The instructions the block keeps. For a Clubhouse Mode agent, what Clubhouse
 * Mode would write at its next wake, wildcards and @@If resolved, so one that
 * never woke doesn't bring over the raw project template. Else the file.
 */
async function instructionsToKeep(projectPath: string, agent: DurableAgentConfig, onDisk: string): Promise<string> {
  if (!usesClubhouseMode(projectPath, agent)) return onDisk;
  try {
    return (await materializedInstructions(projectPath, agent)) ?? onDisk;
  } catch (err) {
    // telemetry-exempt: falls back to the file in its folder, and the preview lists any wildcards left in it.
    appLog('core:managed', 'warn', 'Could not resolve the Clubhouse Mode instructions for the switch to managed', { meta: { agentId: agent.id, error: err instanceof Error ? err.message : String(err) } });
    return onDisk;
  }
}

async function planConvert(projectPath: string, agent: DurableAgentConfig, worktreePath: string, provider: OrchestratorProvider): Promise<ConvertPlan> {
  const conv = provider.conventions;
  const notes: string[] = [];
  const onDisk = await readInstructionsOf(provider, worktreePath);
  const instructions = await instructionsToKeep(projectPath, agent, onDisk);
  // The same checks createPart runs, so the preview and Keep agree.
  let keepInstructions = !!instructions.trim();
  if (keepInstructions) {
    const checked = validatePayload('block', { content: instructions });
    if (checked.ok === false) {
      keepInstructions = false;
      notes.push(`${conv.legacyInstructionsFile || 'The instructions file'} isn't brought over as a block because ${refusal(checked.issues)}. Clubhouse keeps a copy in its app data.`);
    }
  }
  const leftover = keepInstructions ? leftoverWildcards(instructions) : [];
  if (leftover.length > 0) {
    notes.push(`Its instructions still have ${joinAnd(leftover)}, which a managed agent doesn't fill in. Edit the block after the switch.`);
  }

  // What Clubhouse Mode would deliver at the next wake, merged with the folder's own; the folder's copy wins.
  const fromMode = await defaultsToKeep(projectPath, agent);

  const skills: ConvertPlan['skills'] = [];
  const addSkill = async (folder: string, files: ManagedSkillContent['files'], from: PartSource) => {
    const checked = validatePayload('skill', { skillName: folder, files });
    if (checked.ok === false) { notes.push(`The ${folder} skill isn't brought over because ${refusal(checked.issues)}.`); return; }
    skills.push({ folder, from, content: { kind: 'skill', skillName: checked.payload.skillName, files: checked.payload.files.map((f) => ({ ...f })) } });
  };
  const skillsRoot = path.join(worktreePath, conv.configDir, conv.skillsDir);
  let folders: string[] = [];
  try {
    folders = (await fsp.readdir(skillsRoot, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch { /* telemetry-exempt: no skills folder, so no skills to bring over */ }
  const inFolder = new Map<string, ManagedSkillContent['files'] | null>();
  for (const folder of folders) {
    const read = await readSkillFolder(path.join(skillsRoot, folder));
    inFolder.set(folder, 'problem' in read ? null : read.files);
    if ('problem' in read) { notes.push(`The ${folder} skill isn't brought over because ${read.problem}.`); continue; }
    await addSkill(folder, read.files, 'folder');
  }
  for (const source of fromMode?.skills ?? []) {
    if (source.name.startsWith('.')) continue;
    const read = await readSkillFolder(source.path);
    // As Clubhouse Mode copies them: wildcards resolved in text files.
    const files = 'problem' in read ? null : read.files.map((f) => (f.encoding ? f : { ...f, content: fromMode!.resolveText(f.content) }));
    if (inFolder.has(source.name)) {
      const own = inFolder.get(source.name);
      if (!own || !files || !sameSkillFiles(own, files)) notes.push(`The ${source.name} skill in its folder is kept over the project's default of the same name.`);
      continue;
    }
    if (!files) { notes.push(`The ${source.name} skill isn't brought over because ${(read as { problem: string }).problem}.`); continue; }
    await addSkill(source.name, files, 'project');
  }

  const mcps: ConvertPlan['mcps'] = [];
  const addMcp = (serverKey: string, rawDef: unknown, from: PartSource) => {
    // Managed MCP parts keep env names only (D46): literal values are dropped here, and said so.
    const { def, dropped } = envAsNames(rawDef);
    if (dropped.length > 0) notes.push(`${serverKey}: values for ${dropped.join(', ')} aren't kept. Set them in your environment.`);
    const adopted = adoptNativeMcpServer(serverKey, def);
    if (adopted.ok === false) { notes.push(`The ${serverKey} MCP server isn't brought over because ${refusal(adopted.issues)}.`); return; }
    const p = adopted.payload;
    mcps.push({
      serverKey,
      from,
      content: {
        kind: 'mcp',
        serverKey: p.serverKey,
        transport: p.transport,
        ...(p.command !== undefined && { command: p.command }),
        ...(p.args && { args: [...p.args] }),
        ...(p.url !== undefined && { url: p.url }),
        ...(p.envVars && { envVars: [...p.envVars] }),
      },
    });
  };
  let raw: string | null = null;
  try {
    raw = conv.settingsFormat === 'toml' ? null : await readLocalMcpJson(worktreePath, conv);
    if (conv.settingsFormat === 'toml') notes.push(`MCP servers in ${conv.mcpConfigFile} aren't brought over because Clubhouse can't read that format yet.`);
  } catch {
    // telemetry-exempt: the file becomes a note in the preview.
    notes.push(`MCP servers in ${conv.mcpConfigFile} aren't brought over because Clubhouse can't read the file.`);
  }
  let ownServers: Record<string, unknown> = {};
  if (raw !== null) {
    const parsed = mcpServersIn(raw);
    if (parsed === 'invalid') notes.push(`MCP servers in ${conv.mcpConfigFile} aren't brought over because the file isn't valid JSON.`);
    else if (parsed === 'no_list') notes.push(`MCP servers in ${conv.mcpConfigFile} aren't brought over because the file has no mcpServers list.`);
    else ownServers = parsed;
  }
  for (const [serverKey, rawDef] of Object.entries(ownServers)) {
    // Clubhouse's own bridge is the built-in Clubhouse part, added in convertToManaged.
    if (serverKey === 'clubhouse') continue;
    addMcp(serverKey, rawDef, 'folder');
  }
  if (fromMode?.mcpJson) {
    const parsed = mcpServersIn(fromMode.mcpJson);
    if (parsed === 'invalid') notes.push('The project\'s default MCP servers aren\'t brought over because they aren\'t valid JSON.');
    else if (parsed === 'no_list') notes.push('The project\'s default MCP servers aren\'t brought over because they have no mcpServers list.');
    else {
      for (const [serverKey, rawDef] of Object.entries(parsed)) {
        if (serverKey === 'clubhouse') continue;
        if (Object.prototype.hasOwnProperty.call(ownServers, serverKey)) {
          if (canonicalJson(ownServers[serverKey]) !== canonicalJson(rawDef)) notes.push(`The ${serverKey} MCP server in its ${conv.mcpConfigFile} is kept over the project's default of the same name.`);
          continue;
        }
        addMcp(serverKey, rawDef, 'project');
      }
    }
  }
  if (await hasMcpFileToKeep(worktreePath, conv)) {
    notes.push(`Its ${conv.mcpConfigFile} is copied to ${mcpBackupPath(conv)} in its folder before Clubhouse writes its own. The copy stays out of commits.`);
  }
  return { instructions, onDisk, keepInstructions, blockName: `${agent.name} notes`, skills, mcps, notes };
}

/**
 * The skills and MCP servers Clubhouse Mode would deliver at the next wake, for
 * a Clubhouse Mode agent only. Null for any other agent, or when they can't be
 * resolved (the switch then keeps only what is in its folder).
 */
async function defaultsToKeep(projectPath: string, agent: DurableAgentConfig): Promise<MaterializedDefaults | null> {
  if (!usesClubhouseMode(projectPath, agent)) return null;
  try {
    return await materializedDefaults(projectPath, agent);
  } catch (err) {
    // telemetry-exempt: the switch keeps what is in its folder.
    appLog('core:managed', 'warn', 'Could not resolve the Clubhouse Mode skills and MCP servers for the switch to managed', { meta: { agentId: agent.id, error: err instanceof Error ? err.message : String(err) } });
    return null;
  }
}

/** The mcpServers map in an MCP JSON file, or why there is none. */
function mcpServersIn(raw: string): Record<string, unknown> | 'invalid' | 'no_list' {
  let parsed: { mcpServers?: unknown };
  try {
    parsed = JSON.parse(raw) as { mcpServers?: unknown };
  } catch {
    // telemetry-exempt: becomes a note in the preview.
    return 'invalid';
  }
  if (parsed && typeof parsed.mcpServers === 'object' && parsed.mcpServers && !Array.isArray(parsed.mcpServers)) return parsed.mcpServers as Record<string, unknown>;
  return 'no_list';
}

/** Whether two skill folders hold the same files with the same content. The executable bit is left out: Clubhouse Mode's copy doesn't keep it. */
function sameSkillFiles(a: ManagedSkillContent['files'], b: ManagedSkillContent['files']): boolean {
  const key = (files: ManagedSkillContent['files']) => canonicalJson([...files].map((f) => [f.path, f.encoding ?? 'utf8', f.content]).sort());
  return key(a) === key(b);
}

/** JSON with object keys sorted, to compare two values. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([x], [y]) => x.localeCompare(y)))
    : v));
}

function joinAnd(items: string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * A native MCP server definition with its env as names only: every env entry
 * becomes an env_vars name, and the names whose values were literal (not a
 * `${NAME}` reference to themselves) are returned so the preview can say so.
 */
function envAsNames(raw: unknown): { def: unknown; dropped: string[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { def: raw, dropped: [] };
  const def = raw as Record<string, unknown>;
  const env = def.env;
  if (!env || typeof env !== 'object' || Array.isArray(env)) return { def: raw, dropped: [] };
  const names = Object.keys(env);
  if (names.length === 0) return { def: raw, dropped: [] };
  const dropped = names.filter((name) => (env as Record<string, unknown>)[name] !== `\${${name}}`);
  const existing = Array.isArray(def.env_vars) ? def.env_vars.filter((x): x is string => typeof x === 'string') : [];
  const { env: _values, ...rest } = def;
  return { def: { ...rest, env_vars: [...new Set([...existing, ...names])] }, dropped };
}

async function agentForConvert(projectPath: string, agentId: string): Promise<DurableAgentConfig & { worktreePath: string }> {
  const agent = await agentConfig.getDurableConfig(projectPath, agentId);
  if (!agent) throw new ManagedError('not_found');
  if (!agent.worktreePath) throw new ManagedError('invalid', 'This agent works in the project folder. Managed agents need their own folder.');
  return agent as DurableAgentConfig & { worktreePath: string };
}

/** What Keep would make of the agent's files, by name, and what it can't bring over. Writes nothing. */
export async function previewConvert(projectPath: string, agentId: string): Promise<ManagedConvertPreview> {
  const agent = await agentForConvert(projectPath, agentId);
  if (agent.managed) throw new ManagedError('invalid', 'This agent is already Clubhouse managed.');
  const provider = await resolveOrchestrator(projectPath, agent.orchestrator);
  const plan = await planConvert(projectPath, agent, agent.worktreePath, provider);
  return {
    blocks: plan.keepInstructions ? [plan.blockName] : [],
    skills: plan.skills.map((s) => s.folder),
    mcps: plan.mcps.map((m) => m.serverKey),
    notes: plan.notes,
  };
}

/** A part named after this agent, with a number added when the name is taken. */
async function createAgentPart(name: string, description: string, content: ManagedPartContent): Promise<string> {
  const service = managedAgents();
  for (let n = 1; n < 100; n++) {
    try {
      return (await service.createPart({ name: n === 1 ? name : `${name} ${n}`, description, content })).id;
    } catch (err) {
      if (err instanceof ManagedError && err.code === 'name_taken') continue;
      throw err;
    }
  }
  return (await service.createPart({ name: `${name} ${Date.now().toString(36)}`, description, content })).id;
}

/**
 * Switch an existing agent to managed (#2893). Keep turns its current
 * instructions file into a block, and its skill folders and MCP servers into
 * custom parts, all for this agent only. For a Clubhouse Mode agent the block
 * is what Clubhouse Mode would write, and the project's default skills and MCP
 * servers it would deliver are added, the folder's own copy winning on a name
 * clash. What can't be brought over is listed
 * by previewConvert first. Nothing on disk is deleted: the next start
 * overwrites the instructions file it manages, and skill folders it replaces
 * are moved to app data (D15).
 *
 * A managed agent has no persona layer, so what its persona gave its
 * orchestration policy becomes its own first, and a persona change's
 * reconcile runs after (#2901). The setup is checked before any part is made,
 * and a switch that fails after that removes the parts it made and puts the
 * policy back.
 */
export async function convertToManaged(projectPath: string, agentId: string, options: { keep: boolean; templateId?: string }): Promise<ManagedAgentSetup> {
  const service = managedAgents();
  const agent = await agentForConvert(projectPath, agentId);
  if (agent.managed) return agent.managed;
  if (!options.keep && !options.templateId) throw new ManagedError('invalid', 'Choose a template, or keep what the agent has now.');
  const provider = await resolveOrchestrator(projectPath, agent.orchestrator);
  if (!options.keep && options.templateId) {
    const { setup, settings } = await service.setupFromTemplate(options.templateId);
    await service.checkSetup(setup);
    await backupInstructions(agent.id, provider.conventions.legacyInstructionsFile, await readInstructionsOf(provider, agent.worktreePath));
    await keepMcpFile(projectPath, agent.worktreePath, provider);
    return switchWith(projectPath, agent, [], () => service.saveSetup(projectPath, agentId, setup), () => applyManagedSettings(projectPath, agentId, settingsForConvert(provider.id, settings)));
  }
  const plan = await planConvert(projectPath, agent, agent.worktreePath, provider);
  const bridge = agent.mcpOverride === false ? [] : [CLUBHOUSE_MCP_PART_ID];
  // Before any part is made, so a setup that can't be saved leaves nothing behind.
  await service.checkSetup({ blocks: [], skills: [], mcps: bridge }, { skillFolders: plan.skills.map((s) => s.content.skillName) });
  await backupInstructions(agent.id, provider.conventions.legacyInstructionsFile, plan.onDisk);
  await keepMcpFile(projectPath, agent.worktreePath, provider);
  const made: string[] = [];
  const make = async (name: string, description: string, content: ManagedPartContent) => {
    const id = await createAgentPart(name, description, content);
    made.push(id);
    return id;
  };
  return switchWith(projectPath, agent, made, async () => {
    const blocks: string[] = [];
    if (plan.keepInstructions) {
      blocks.push(await make(plan.blockName, `What ${agent.name} had before it was managed.`, { kind: 'block', content: plan.instructions }));
    }
    const skills: string[] = [];
    for (const skill of plan.skills) {
      skills.push(await make(`${skill.folder}, ${agent.name}`, skill.from === 'project'
        ? `The ${skill.folder} skill Clubhouse Mode gave ${agent.name} from the project's defaults before it was managed.`
        : `The ${skill.folder} skill ${agent.name} had before it was managed.`, skill.content));
    }
    const mcps: string[] = [...bridge];
    for (const mcp of plan.mcps) {
      mcps.push(await make(`${mcp.serverKey}, ${agent.name}`, mcp.from === 'project'
        ? `The ${mcp.serverKey} MCP server Clubhouse Mode gave ${agent.name} from the project's defaults before it was managed.`
        : `The ${mcp.serverKey} MCP server ${agent.name} had before it was managed.`, mcp.content));
    }
    return service.saveSetup(projectPath, agentId, { blocks, skills, mcps });
  });
}

/**
 * The switch itself: keep the persona's orchestration defaults on the agent,
 * save the setup, then settle as a persona change does. On a failure before
 * the setup is saved, the parts in `made` are removed and the policy put back.
 */
async function switchWith(
  projectPath: string,
  agent: DurableAgentConfig,
  made: string[],
  save: () => Promise<ManagedAgentSetup>,
  after?: () => Promise<void>,
): Promise<ManagedAgentSetup> {
  let carry: CarriedPersonaOrchestration | null = null;
  let saved: ManagedAgentSetup;
  try {
    carry = await carryPersonaOrchestration(projectPath, agent.id);
    saved = await save();
  } catch (err) {
    await undoSwitch(projectPath, agent, made, carry);
    throw err;
  }
  await markAwaitingFirstStart(agent.id).catch((err) => {
    // telemetry-exempt: the switch stands; the first start just doesn't check the file again.
    appLog('core:managed', 'warn', 'Could not mark the agent for a last instructions check at its first managed start', { meta: { agentId: agent.id, error: err instanceof Error ? err.message : String(err) } });
  });
  // As after a persona change: with live helpers, orchestration stays on.
  await reconcileAfterPersonaChange(projectPath, agent.id, carry?.previousPersona);
  if (after) await after();
  return saved;
}

async function undoSwitch(projectPath: string, agent: DurableAgentConfig, made: string[], carry: CarriedPersonaOrchestration | null): Promise<void> {
  const service = managedAgents();
  for (const id of made) {
    try {
      const part = await service.getPart(id);
      await service.deletePart({ id, expectedRevision: part.revision, mode: 'remove' });
    } catch (err) {
      // telemetry-exempt: logged; the part stays in the library, unused, where it can be deleted.
      appLog('core:managed', 'warn', 'Could not remove a part a failed switch to managed made', { meta: { agentId: agent.id, partId: id, error: err instanceof Error ? err.message : String(err) } });
    }
  }
  if (carry) {
    await restorePersonaOrchestration(projectPath, agent.id, carry).catch((err) => {
      // telemetry-exempt: logged; the fields it kept give the same policy as the persona did.
      appLog('core:managed', 'warn', 'Could not put the orchestration policy back after a failed switch to managed', { meta: { agentId: agent.id, error: err instanceof Error ? err.message : String(err) } });
    });
  }
  await clearAwaitingFirstStart(agent.id).catch(() => { /* telemetry-exempt: nothing was marked */ });
}

/**
 * A template's settings for an agent switching to managed. The agent keeps
 * its CLI, so it keeps its conversation (D51): the template's CLI isn't
 * applied, and neither is its model when the template is for another CLI.
 */
export function settingsForConvert(currentCli: string, settings: ManagedTemplateSettings): ManagedTemplateSettings {
  const { orchestrator, model, ...rest } = settings;
  const sameCli = !orchestrator || orchestrator === currentCli;
  return { ...rest, ...(model !== undefined && sameCli && { model }) };
}

/** Copy the agent's MCP file aside in its folder before the first managed start overwrites it (D54). */
async function keepMcpFile(projectPath: string, worktree: string, provider: OrchestratorProvider): Promise<void> {
  const kept = await backupMcpFile(worktree, provider.conventions);
  if (!kept) return;
  try {
    const gitExclude = await import('../git-exclude-manager');
    await gitExclude.addExclusions(projectPath, 'clubhouse-managed-backup', [`${MCP_BACKUP_DIR}/`]);
  } catch (err) {
    // telemetry-exempt: not a git project, or the exclude file is read-only; the copy is kept either way.
    appLog('core:managed', 'warn', 'Could not add the kept MCP file to git excludes', { meta: { error: err instanceof Error ? err.message : String(err) } });
  }
}
