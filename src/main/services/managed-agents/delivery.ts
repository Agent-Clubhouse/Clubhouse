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
import * as path from 'path';
import { composeInstructions } from '../asset-catalog/composer';
import { canonicalHash } from '../asset-catalog/planner';
import { replaceWildcards } from '../../../shared/wildcard-replacer';
import { buildWildcardContext, resolveAgentCommands, resolveSourceControlProvider } from '../materialization-service';
import { readProjectAgentDefaults } from '../agent-settings-service';
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
import type { ManagedAgentsService } from './service';

/** Written beside the managed skills so a later start removes only what Clubhouse put there. */
const SKILLS_MANIFEST = '.clubhouse-managed-skills.json';

interface Resolved {
  blocks: Array<{ id: string; name: string; builtin: boolean; revision: number; content: string }>;
  skills: Array<{ id: string; name: string; revision: number; content: ManagedSkillContent }>;
  mcps: Array<{ id: string; name: string; revision: number; builtin: boolean; content: ManagedMcpContent }>;
  missing: string[];
}

async function resolveSetup(service: ManagedAgentsService, setup: ManagedAgentSetup): Promise<Resolved> {
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
    out.mcps.push({ id, name: head.entry.name, revision: head.entry.headRevision, builtin: head.entry.source.kind === 'builtin', content: head.content });
  }
  return out;
}

async function wildcardContextFor(projectPath: string, agent: DurableAgentConfig) {
  const defaults = await readProjectAgentDefaults(projectPath);
  const scp = await resolveSourceControlProvider(projectPath, agent);
  return buildWildcardContext(agent, projectPath, scp, resolveAgentCommands(agent, defaults));
}

/** What the setup renders to, with wildcards filled in for this agent. */
export async function renderManagedInstructions(projectPath: string, agent: DurableAgentConfig, resolved: Resolved): Promise<string> {
  const composed = composeInstructions(resolved.blocks.map((b) => ({ content: b.content })));
  if (composed.ok === false) throw new Error(composed.code);
  const ctx = await wildcardContextFor(projectPath, agent);
  return replaceWildcards(composed.text, ctx, { conditionals: false });
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
    if (c.envVars && c.envVars.length > 0) def.env_vars = [...c.envVars];
    if (c.env && Object.keys(c.env).length > 0) def.env = { ...c.env };
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

async function writeSkills(worktree: string, provider: OrchestratorProvider, skills: Resolved['skills'], backupRoot?: string): Promise<void> {
  const conv = provider.conventions;
  const root = path.join(worktree, conv.configDir, conv.skillsDir);
  await fsp.mkdir(root, { recursive: true });
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
    if (exists && !previous.includes(skill.content.skillName)) await moveAside(dir, backupRoot);
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
  const instructions = await renderManagedInstructions(projectPath, agent, resolved);
  await provider.writeInstructions(agent.worktreePath, instructions);
  await writeSkills(agent.worktreePath, provider, resolved.skills, params.backupRoot);
  await writeMcpFile(agent.worktreePath, provider, mcpServersOf(resolved));
  return { ...setupFingerprint(agent, resolved), ...(resolved.missing.length > 0 && { missing: resolved.missing.length }) };
}

/** What a quick agent gets from a template (#2893, D25). */
export interface QuickManagedLaunch {
  templateId: string;
  /** The template's blocks, joined and filled in for this quick agent. Goes in the system prompt. */
  instructions: string;
  /** The template's MCP servers, for the launch flags. The Clubhouse bridge is separate. */
  servers: Record<string, McpServerDef>;
  /** Whether the template lists the Clubhouse MCP part. Without it the agent gets no bridge. */
  bridge: boolean;
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
  const { setup } = await params.service.setupFromTemplate(params.templateId);
  const resolved = await resolveSetup(params.service, setup);
  const agent: DurableAgentConfig = {
    id: params.agentId, name: params.agentName, color: 'gray', createdAt: new Date().toISOString(),
    worktreePath: params.cwd, ...(params.branch && { branch: params.branch }),
  };
  const composed = composeInstructions(resolved.blocks.map((b) => ({ content: b.content })));
  if (composed.ok === false) throw new Error(composed.code);
  const ctx = await wildcardContextFor(params.projectPath, agent);
  const rel = path.relative(params.projectPath, params.cwd).replace(/\\/g, '/');
  ctx.agentPath = rel ? `${rel}/` : './';
  if (!params.branch) ctx.standbyBranch = 'the checked-out branch';
  return {
    templateId: params.templateId,
    instructions: replaceWildcards(composed.text, ctx, { conditionals: false }),
    servers: mcpServersOf(resolved),
    bridge: setup.mcps.includes(CLUBHOUSE_MCP_PART_ID),
    skippedSkills: resolved.skills.length,
    missing: resolved.missing.length,
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
  const ctx = await wildcardContextFor(params.projectPath, params.agent);
  const usage = new Map<string, number>();
  for (const b of resolved.blocks) usage.set(b.id, (await params.service.consumers(b.id)).length);
  let line = 1;
  const blocks = resolved.blocks.map((b) => {
    const lines = replaceWildcards(b.content, ctx, { conditionals: false }).split('\n').length;
    const entry = { id: b.id, name: b.name, builtin: b.builtin, usedBy: usage.get(b.id) ?? 0, startLine: line, endLine: line + lines - 1 };
    line += lines + 1;
    return entry;
  });
  const conv = params.provider?.conventions;
  const folderRoot = conv ? path.join(conv.configDir, conv.skillsDir) : 'skills';
  return {
    instructions,
    blocks,
    skills: resolved.skills.map((s) => ({ id: s.id, name: s.name, skillName: s.content.skillName, files: s.content.files.length, folder: `${folderRoot}/${s.content.skillName}`.replace(/\\/g, '/') })),
    mcps: resolved.mcps.map((m) => ({ id: m.id, name: m.name, serverKey: m.content.serverKey, builtin: m.builtin })),
    missing: resolved.missing,
  };
}

export type { Resolved as ResolvedManagedSetup };
export { resolveSetup as resolveManagedSetup };
