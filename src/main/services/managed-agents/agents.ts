/**
 * Agent-level managed operations (#2893): create a managed agent, preview
 * and switch an existing one to managed, and apply a template's settings.
 * They combine the managed-agents service with agent config and
 * orchestration policy.
 */
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as agentConfig from '../agent-config';
import { setOrchestrationPolicy } from '../orchestration-policy';
import { resolveOrchestrator } from '../agent-system';
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
import { managedStateDir } from './state-store';
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

interface ConvertPlan {
  /** The instructions file as it is now; empty when there is none. */
  instructions: string;
  /** Whether the instructions become a block. False when there are none, or the catalog would refuse them. */
  keepInstructions: boolean;
  /** The block the instructions become. */
  blockName: string;
  skills: Array<{ folder: string; content: ManagedSkillContent }>;
  mcps: Array<{ serverKey: string; content: ManagedMcpContent }>;
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

async function planConvert(agent: DurableAgentConfig, worktreePath: string, provider: OrchestratorProvider): Promise<ConvertPlan> {
  const conv = provider.conventions;
  const notes: string[] = [];
  const instructions = await readInstructionsOf(provider, worktreePath);
  // The same checks createPart runs, so the preview and Keep agree.
  let keepInstructions = !!instructions.trim();
  if (keepInstructions) {
    const checked = validatePayload('block', { content: instructions });
    if (checked.ok === false) {
      keepInstructions = false;
      notes.push(`${conv.legacyInstructionsFile || 'The instructions file'} isn't brought over as a block because ${refusal(checked.issues)}. Clubhouse keeps a copy in its app data.`);
    }
  }

  const skills: ConvertPlan['skills'] = [];
  const skillsRoot = path.join(worktreePath, conv.configDir, conv.skillsDir);
  let folders: string[] = [];
  try {
    folders = (await fsp.readdir(skillsRoot, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch { /* telemetry-exempt: no skills folder, so no skills to bring over */ }
  for (const folder of folders) {
    const read = await readSkillFolder(path.join(skillsRoot, folder));
    if ('problem' in read) { notes.push(`The ${folder} skill isn't brought over because ${read.problem}.`); continue; }
    const checked = validatePayload('skill', { skillName: folder, files: read.files });
    if (checked.ok === false) { notes.push(`The ${folder} skill isn't brought over because ${refusal(checked.issues)}.`); continue; }
    skills.push({ folder, content: { kind: 'skill', skillName: checked.payload.skillName, files: checked.payload.files.map((f) => ({ ...f })) } });
  }

  const mcps: ConvertPlan['mcps'] = [];
  let raw: string | null = null;
  try {
    raw = conv.settingsFormat === 'toml' ? null : await readLocalMcpJson(worktreePath, conv);
    if (conv.settingsFormat === 'toml') notes.push(`MCP servers in ${conv.mcpConfigFile} aren't brought over because Clubhouse can't read that format yet.`);
  } catch {
    // telemetry-exempt: the file becomes a note in the preview.
    notes.push(`MCP servers in ${conv.mcpConfigFile} aren't brought over because Clubhouse can't read the file.`);
  }
  if (raw !== null) {
    let servers: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(raw) as { mcpServers?: unknown };
      if (parsed && typeof parsed.mcpServers === 'object' && parsed.mcpServers && !Array.isArray(parsed.mcpServers)) servers = parsed.mcpServers as Record<string, unknown>;
      else notes.push(`MCP servers in ${conv.mcpConfigFile} aren't brought over because the file has no mcpServers list.`);
    } catch {
      // telemetry-exempt: the file becomes a note in the preview.
      notes.push(`MCP servers in ${conv.mcpConfigFile} aren't brought over because the file isn't valid JSON.`);
    }
    for (const [serverKey, rawDef] of Object.entries(servers)) {
      // Clubhouse's own bridge is the built-in Clubhouse part, added below.
      if (serverKey === 'clubhouse') continue;
      // Managed MCP parts keep env names only (D46): literal values are dropped here, and said so.
      const { def, dropped } = envAsNames(rawDef);
      if (dropped.length > 0) notes.push(`${serverKey}: values for ${dropped.join(', ')} aren't kept. Set them in your environment.`);
      const adopted = adoptNativeMcpServer(serverKey, def);
      if (adopted.ok === false) { notes.push(`The ${serverKey} MCP server isn't brought over because ${refusal(adopted.issues)}.`); continue; }
      const p = adopted.payload;
      mcps.push({
        serverKey,
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
    }
  }
  if (await hasMcpFileToKeep(worktreePath, conv)) {
    notes.push(`Its ${conv.mcpConfigFile} is copied to ${mcpBackupPath(conv)} in its folder before Clubhouse writes its own. The copy stays out of commits.`);
  }
  return { instructions, keepInstructions, blockName: `${agent.name} notes`, skills, mcps, notes };
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
  const plan = await planConvert(agent, agent.worktreePath, provider);
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
 * custom parts, all for this agent only. What can't be brought over is listed
 * by previewConvert first. Nothing on disk is deleted: the next start
 * overwrites the instructions file it manages, and skill folders it replaces
 * are moved to app data (D15).
 */
export async function convertToManaged(projectPath: string, agentId: string, options: { keep: boolean; templateId?: string }): Promise<ManagedAgentSetup> {
  const service = managedAgents();
  const agent = await agentForConvert(projectPath, agentId);
  if (agent.managed) return agent.managed;
  if (!options.keep && !options.templateId) throw new ManagedError('invalid', 'Choose a template, or keep what the agent has now.');
  const provider = await resolveOrchestrator(projectPath, agent.orchestrator);
  if (!options.keep && options.templateId) {
    await backupInstructions(agent, provider.conventions.legacyInstructionsFile, await readInstructionsOf(provider, agent.worktreePath));
    await keepMcpFile(projectPath, agent.worktreePath, provider);
    const { setup, settings } = await service.setupFromTemplate(options.templateId);
    const saved = await service.saveSetup(projectPath, agentId, setup);
    await applyManagedSettings(projectPath, agentId, settingsForConvert(provider.id, settings));
    return saved;
  }
  const plan = await planConvert(agent, agent.worktreePath, provider);
  await backupInstructions(agent, provider.conventions.legacyInstructionsFile, plan.instructions);
  await keepMcpFile(projectPath, agent.worktreePath, provider);
  const blocks: string[] = [];
  if (plan.keepInstructions) {
    blocks.push(await createAgentPart(plan.blockName, `What ${agent.name} had before it was managed.`, { kind: 'block', content: plan.instructions }));
  }
  const skills: string[] = [];
  for (const skill of plan.skills) {
    skills.push(await createAgentPart(`${skill.folder}, ${agent.name}`, `The ${skill.folder} skill ${agent.name} had before it was managed.`, skill.content));
  }
  const mcps: string[] = agent.mcpOverride === false ? [] : [CLUBHOUSE_MCP_PART_ID];
  for (const mcp of plan.mcps) {
    mcps.push(await createAgentPart(`${mcp.serverKey}, ${agent.name}`, `The ${mcp.serverKey} MCP server ${agent.name} had before it was managed.`, mcp.content));
  }
  return service.saveSetup(projectPath, agentId, { blocks, skills, mcps });
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

/** Keep a copy of the instructions file before Clubhouse takes it over, so nothing is lost. */
async function backupInstructions(agent: DurableAgentConfig, file: string, existing: string): Promise<void> {
  if (!existing) return;
  const backup = path.join(managedStateDir(), 'before-managed', agent.id);
  await fsp.mkdir(backup, { recursive: true });
  await fsp.writeFile(path.join(backup, path.basename(file || 'instructions.md')), existing, 'utf-8');
}
