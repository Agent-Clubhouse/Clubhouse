/**
 * The project's legacy agent defaults (#3245): read them, import them as
 * Managed Agent parts, or copy them into a plain agent. Every write is asked
 * for and previewed; nothing here runs on its own, and the saved values are
 * never changed or removed, so they stay readable while they're retired.
 *
 * A copy is the same whether it goes into a new agent (the New agent page's
 * "Copy this project's legacy defaults") or an existing one: instructions are
 * written, or added to the end of the agent's own; permission rules and MCP
 * servers are added to what it has; build, test and lint commands become its
 * own where it has none. A CLI that can't take a value skips it.
 */
import { execFile } from 'child_process';
import * as fsp from 'fs/promises';
import * as path from 'path';
import type { DurableAgentConfig, PermissionsConfig, ProjectAgentDefaults } from '../../shared/types';
import type {
  LegacyChange,
  LegacyCopyPreview,
  LegacyDefaultsSummary,
  LegacyImportPreview,
  LegacyImportResult,
} from '../../shared/legacy-defaults-types';
import { hasLegacyAgentDefaults } from '../../shared/project-settings-ownership';
import { isValidPluginId } from '../../shared/manifest-validator';
import { isDisposedAgent } from '../../shared/agent-helpers';
import { replaceWildcards, type WildcardContext } from '../../shared/wildcard-replacer';
import type { ManagedMcpContent, ManagedPartContent } from '../../shared/managed-agents-types';
import type { OrchestratorProvider } from '../orchestrators/types';
import { readLocalMcpJson, readProjectAgentDefaults, writePermissions } from './agent-settings-service';
import { buildWildcardContext, resolveAgentCommands, resolveSourceControlProvider } from './agent-wildcards';
import { appLog } from './log-service';

const LOG_NS = 'core:legacy-defaults';

const PLUGIN_INSTRUCTION_REGEX = /<!-- plugin:([^:]+):start -->([\s\S]*?)<!-- plugin:\1:end -->/g;

type Commands = { buildCommand?: string; testCommand?: string; lintCommand?: string };
const COMMAND_KEYS = ['buildCommand', 'testCommand', 'lintCommand'] as const;
const COMMAND_NAMES: Record<(typeof COMMAND_KEYS)[number], string> = { buildCommand: 'Build', testCommand: 'Test', lintCommand: 'Lint' };

// agent-config loads this module on use, and this module uses agent-config: load it on use too.
const agentConfig = () => import('./agent-config');
// Loaded on use, so the phone, MCP and Annex modules that ask legacyDefaultsNotCopied don't pull in agent-system.
async function resolveOrchestrator(projectPath: string, orchestrator?: string): Promise<OrchestratorProvider> {
  return (await import('./agent-system')).resolveOrchestrator(projectPath, orchestrator as never);
}

function pluginOfServer(key: string): string | undefined {
  // Plugin servers are saved as `plugin-<pluginId>-<name>` (config-provenance-service).
  const m = /^plugin-(.+?)-.+$/.exec(key);
  return m ? m[1] : undefined;
}

function serversIn(json: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(json) as { mcpServers?: unknown };
    const servers = parsed?.mcpServers;
    return servers && typeof servers === 'object' && !Array.isArray(servers) ? servers as Record<string, unknown> : {};
  } catch {
    // telemetry-exempt: shown as invalid JSON
    return null;
  }
}

function userInstructionsOf(text: string): { own: string; plugins: Array<{ pluginId: string; text: string }> } {
  const plugins: Array<{ pluginId: string; text: string }> = [];
  let own = text;
  for (const m of text.matchAll(PLUGIN_INSTRUCTION_REGEX)) {
    plugins.push({ pluginId: m[1], text: m[2].trim() });
    own = own.replace(m[0], '');
  }
  return { own: own.replace(/\n{3,}/g, '\n\n').trim(), plugins };
}

function commandsOf(defaults: ProjectAgentDefaults): Commands {
  const out: Commands = {};
  for (const key of COMMAND_KEYS) if (defaults[key]?.trim()) out[key] = defaults[key];
  return out;
}

function isPlain(agent: DurableAgentConfig): boolean {
  return !agent.managed && !isDisposedAgent(agent);
}

/** Whether an unmanaged agent gets the project's MCP servers at start (agent-mcp-servers.ts). */
async function inheritsProjectMcp(projectPath: string, agent: DurableAgentConfig): Promise<boolean> {
  try {
    const provider = await resolveOrchestrator(projectPath, agent.orchestrator);
    if (provider.conventions.settingsFormat === 'toml') return true;
    return (await readLocalMcpJson(agent.worktreePath || projectPath, provider.conventions)) === null;
  } catch {
    // telemetry-exempt: an agent whose CLI or file can't be read isn't listed
    return false;
  }
}

/** The project's legacy defaults, as the settings page shows them, with where they still apply. */
export async function describeLegacyDefaults(projectPath: string): Promise<LegacyDefaultsSummary> {
  const defaults = await readProjectAgentDefaults(projectPath);
  const { own, plugins } = userInstructionsOf(defaults.instructions ?? '');
  const mcpJson = defaults.mcpJson ?? '';
  const servers = mcpJson.trim() ? serversIn(mcpJson) : {};
  const { listDurable } = await agentConfig();
  const agents = (await listDurable(projectPath)).filter(isPlain);
  const inheritingMcp: LegacyDefaultsSummary['inheritingMcp'] = [];
  const plainAgents: LegacyDefaultsSummary['plainAgents'] = [];
  for (const agent of agents) {
    if (agent.creation) continue;
    if (servers && Object.keys(servers).length > 0 && await inheritsProjectMcp(projectPath, agent)) inheritingMcp.push({ id: agent.id, name: agent.name });
    if (agent.worktreePath) {
      const cli = await resolveOrchestrator(projectPath, agent.orchestrator).then((p) => p.displayName, (): string => agent.orchestrator ?? '');
      plainAgents.push({ id: agent.id, name: agent.name, cli });
    }
  }
  return {
    hasValues: hasLegacyAgentDefaults(defaults),
    instructions: own,
    pluginInstructions: plugins.map((p) => ({ pluginId: p.pluginId, label: p.text })),
    permissions: { allow: [...(defaults.permissions?.allow ?? [])], deny: [...(defaults.permissions?.deny ?? [])] },
    mcpServers: Object.keys(servers ?? {}).map((key) => ({ key, ...(pluginOfServer(key) && { pluginId: pluginOfServer(key) }) })),
    mcpJsonValid: servers !== null,
    mcpJson,
    commands: commandsOf(defaults),
    inheritingMcp,
    plainAgents,
  };
}

/**
 * For a plain agent made without the New agent page (MCP, Annex, a phone):
 * `'not_copied'` when the project has legacy defaults it didn't get, so the
 * result can say so (#3245). Undefined when there are none, or they can't be read.
 */
export async function legacyDefaultsNotCopied(projectPath: string): Promise<'not_copied' | undefined> {
  try {
    return hasLegacyAgentDefaults(await readProjectAgentDefaults(projectPath)) ? 'not_copied' : undefined;
  } catch {
    // telemetry-exempt: the result just doesn't mention them
    return undefined;
  }
}

// ── Copy into a plain agent ──────────────────────────────────────────────

function jsonEscaped(ctx: WildcardContext): WildcardContext {
  const esc = (v: string | undefined) => (v === undefined ? undefined : JSON.stringify(v).slice(1, -1));
  return {
    agentName: esc(ctx.agentName)!, standbyBranch: esc(ctx.standbyBranch)!, agentPath: esc(ctx.agentPath)!,
    sourceControlProvider: esc(ctx.sourceControlProvider),
    buildCommand: esc(ctx.buildCommand ?? 'npm run build'), testCommand: esc(ctx.testCommand ?? 'npm test'), lintCommand: esc(ctx.lintCommand ?? 'npm run lint'),
  };
}

function rel(file: string): string {
  return file.replace(/\\/g, '/');
}

function instructionsFile(provider: OrchestratorProvider): string {
  const conv = provider.conventions;
  // Copilot reads its instructions from inside its config folder (managed-agents/delivery instructionsFileRel).
  return provider.id === 'copilot-cli' ? path.join(conv.configDir, conv.legacyInstructionsFile) : conv.legacyInstructionsFile;
}

/**
 * Reads a file of the agent's folder, by its path relative to the folder, or
 * null when there's none. A copy reads only through this, so its preview and
 * the copy itself read the same files.
 */
type FolderReader = (relPath: string) => Promise<string | null>;

/** The files of a folder on disk: an existing agent's, or a new one's once its worktree is made. */
function folderReader(dir: string): FolderReader {
  return (relPath) => fsp.readFile(path.join(dir, relPath), 'utf-8').catch((): null => null);
}

function gitShow(projectPath: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: projectPath, encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => resolve(error ? null : stdout));
  });
}

/**
 * The files a new agent's worktree will have before anything is copied: what
 * git checks out for its branch. The default `<name>/standby` branch is used
 * as it is when it already exists, else it starts at the project's HEAD
 * (agent-config's creation). Nothing when the project isn't a git repository:
 * the folder starts empty.
 */
async function newWorktreeReader(projectPath: string, branch: string): Promise<FolderReader> {
  const existing = await gitShow(projectPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
  const head = existing?.trim() || (await gitShow(projectPath, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']))?.trim();
  if (!head) return async () => null;
  return (relPath) => gitShow(projectPath, ['show', `${head}:${relPath.replace(/\\/g, '/')}`]);
}

/** A local settings file's permission rules, as readPermissions reads them: none when it's missing or not valid. */
function permissionsIn(raw: string | null): PermissionsConfig {
  if (raw === null) return {};
  try {
    const perms = (JSON.parse(raw) as { permissions?: { allow?: unknown; deny?: unknown } })?.permissions;
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined);
    return { ...(strings(perms?.allow) && { allow: strings(perms?.allow) }), ...(strings(perms?.deny) && { deny: strings(perms?.deny) }) };
  } catch {
    // telemetry-exempt: an unreadable file has no rules to keep, as readPermissions treats it
    return {};
  }
}

interface CopyPlan {
  changes: LegacyChange[];
  /** Writes what the changes say. Commands go through `saveCommands`. */
  apply: (saveCommands: (fields: Commands) => Promise<void>) => Promise<void>;
}

/**
 * What a copy of the legacy defaults into `agent`'s folder does, and how to do
 * it. Reads the folder's files through `read` only; writes nothing until
 * `apply`, and then into `agent.worktreePath`.
 */
async function planCopy(projectPath: string, agent: DurableAgentConfig, provider: OrchestratorProvider, defaults: ProjectAgentDefaults, read: FolderReader): Promise<CopyPlan> {
  const wt = agent.worktreePath!;
  const conv = provider.conventions;
  const scp = await resolveSourceControlProvider(projectPath, agent).catch((): undefined => undefined);
  const ctx = buildWildcardContext(agent, projectPath, scp, resolveAgentCommands(agent, defaults));
  const changes: LegacyChange[] = [];
  const writes: Array<() => Promise<void>> = [];

  // Instructions: written, or added to the end of the agent's own.
  const text = defaults.instructions?.trim() ? replaceWildcards(defaults.instructions, ctx).trim() : '';
  if (text) {
    const file = rel(instructionsFile(provider));
    const current = (await read(instructionsFile(provider))) ?? '';
    // Compared without line endings: git can check a file out with CRLF while `git show` gives LF.
    if (current.replace(/\r\n/g, '\n').includes(text)) {
      changes.push({ item: 'instructions', target: file, action: 'unchanged', detail: 'Already in the file.' });
    } else if (!current.trim()) {
      changes.push({ item: 'instructions', target: file, action: 'write', detail: `Written with the project's instructions (${text.split('\n').length} lines).` });
      writes.push(() => Promise.resolve(provider.writeInstructions(wt, `${text}\n`)));
    } else {
      changes.push({ item: 'instructions', target: file, action: 'append', detail: `The project's instructions (${text.split('\n').length} lines) are added to the end. What's there stays.` });
      writes.push(() => Promise.resolve(provider.writeInstructions(wt, `${current.trimEnd()}\n\n${text}\n`)));
    }
  }

  // Permission rules: added to the agent's own, where its CLI has them.
  const allow = (defaults.permissions?.allow ?? []).map((r) => replaceWildcards(r, ctx));
  const deny = (defaults.permissions?.deny ?? []).map((r) => replaceWildcards(r, ctx));
  if (allow.length > 0 || deny.length > 0) {
    const file = rel(path.join(conv.configDir, conv.localSettingsFile || 'settings.local.json'));
    if (conv.permissionRules === false) {
      changes.push({ item: 'permissions', target: file, action: 'skip', detail: `${provider.displayName} has no allow and deny rules, so they aren't copied. Set its access in its own settings.` });
    } else {
      const current = permissionsIn(await read(path.join(conv.configDir, conv.localSettingsFile || 'settings.local.json')));
      const addAllow = allow.filter((r) => !(current.allow ?? []).includes(r));
      const addDeny = deny.filter((r) => !(current.deny ?? []).includes(r));
      if (addAllow.length === 0 && addDeny.length === 0) {
        changes.push({ item: 'permissions', target: file, action: 'unchanged', detail: 'It already has every rule.' });
      } else {
        const parts = [addAllow.length > 0 && `${addAllow.length} allow`, addDeny.length > 0 && `${addDeny.length} deny`].filter(Boolean).join(' and ');
        const hasOwn = (current.allow?.length ?? 0) + (current.deny?.length ?? 0) > 0;
        const rules = addAllow.length + addDeny.length === 1 ? 'rule is' : 'rules are';
        changes.push(hasOwn
          ? { item: 'permissions', target: file, action: 'merge', detail: `${parts} ${rules} added to its own.` }
          : { item: 'permissions', target: file, action: 'write', detail: `${parts} ${rules} written.` });
        const next: PermissionsConfig = { allow: [...(current.allow ?? []), ...addAllow], deny: [...(current.deny ?? []), ...addDeny] };
        writes.push(() => writePermissions(wt, next, conv));
      }
    }
  }

  // MCP servers: added to the agent's own MCP file.
  if (defaults.mcpJson?.trim()) {
    const file = rel(conv.mcpConfigFile);
    const json = replaceWildcards(defaults.mcpJson, jsonEscaped(ctx));
    const parsed = serversIn(json);
    const servers = parsed ? Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== 'clubhouse')) : null;
    // A new file keeps the project JSON's other top-level keys, as the old snapshot wrote it whole.
    const projectRest = (): Record<string, unknown> => {
      const { mcpServers: _servers, ...rest } = JSON.parse(json) as Record<string, unknown>;
      return rest;
    };
    if (servers === null) {
      changes.push({ item: 'mcp', target: file, action: 'skip', detail: 'The project\'s MCP JSON isn\'t valid JSON, so nothing is copied.' });
    } else if (Object.keys(servers).length === 0) {
      // Nothing to copy.
    } else if (conv.settingsFormat === 'toml') {
      const exists = (await read(conv.mcpConfigFile)) !== null;
      if (exists) {
        changes.push({ item: 'mcp', target: file, action: 'skip', detail: `It already has ${file}, which Clubhouse doesn't add to. ${provider.displayName} gets the project's servers at start while the legacy defaults last.` });
      } else {
        changes.push({ item: 'mcp', target: file, action: 'write', detail: `Written with ${Object.keys(servers).length} MCP ${Object.keys(servers).length === 1 ? 'server' : 'servers'}: ${Object.keys(servers).join(', ')}.` });
        writes.push(async () => {
          const { jsonMcpToToml } = await import('./toml-utils');
          const toml = jsonMcpToToml(JSON.stringify({ mcpServers: servers }));
          if (!toml) return;
          await fsp.mkdir(path.dirname(path.join(wt, conv.mcpConfigFile)), { recursive: true });
          await fsp.writeFile(path.join(wt, conv.mcpConfigFile), toml, 'utf-8');
        });
      }
    } else {
      const raw = await read(conv.mcpConfigFile);
      const own = raw === null ? {} : serversIn(raw);
      if (own === null) {
        changes.push({ item: 'mcp', target: file, action: 'skip', detail: `Its ${file} isn't valid JSON, so nothing is added to it.` });
      } else {
        const add = Object.keys(servers).filter((key) => !(key in own));
        const kept = Object.keys(servers).filter((key) => key in own);
        if (add.length === 0) {
          changes.push({ item: 'mcp', target: file, action: 'unchanged', detail: 'It already has every server.' });
        } else {
          const keptNote = kept.length > 0 ? ` Its own ${kept.join(', ')} ${kept.length === 1 ? 'is' : 'are'} kept.` : '';
          changes.push({
            item: 'mcp', target: file, action: raw === null ? 'write' : 'merge',
            detail: `${raw === null ? 'Written with' : 'Adds'} ${add.join(', ')}.${keptNote} With its own file it no longer gets the project's servers at start.`,
          });
          writes.push(async () => {
            const base = raw === null ? projectRest() : JSON.parse(raw) as Record<string, unknown>;
            const next = { ...base, mcpServers: { ...own, ...Object.fromEntries(add.map((key) => [key, servers[key]])) } };
            await fsp.mkdir(path.dirname(path.join(wt, conv.mcpConfigFile)), { recursive: true });
            await fsp.writeFile(path.join(wt, conv.mcpConfigFile), `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
          });
        }
      }
    }
  }

  // Commands: the project's become the agent's own where it has none.
  const commands: Commands = {};
  for (const key of COMMAND_KEYS) {
    const value = defaults[key]?.trim() ? defaults[key] : undefined;
    if (!value) continue;
    // An empty command is none (#3245 review).
    if (agent[key]?.trim()) {
      changes.push({ item: key, target: `${COMMAND_NAMES[key]} command`, action: 'unchanged', detail: `It has its own: ${agent[key]}` });
    } else {
      commands[key] = value;
      changes.push({ item: key, target: `${COMMAND_NAMES[key]} command`, action: 'set', detail: value });
    }
  }

  return {
    changes,
    apply: async (saveCommands) => {
      for (const write of writes) await write();
      if (Object.keys(commands).length > 0) await saveCommands(commands);
    },
  };
}

async function plainAgentFor(projectPath: string, agentId: string): Promise<DurableAgentConfig> {
  const { getDurableConfig } = await agentConfig();
  const agent = await getDurableConfig(projectPath, agentId);
  if (!agent || !isPlain(agent)) throw new Error('That agent isn\'t a plain agent in this project.');
  return agent;
}

function blockedReason(agent: DurableAgentConfig): string | null {
  if (agent.creation) return 'It\'s still being created.';
  if (!agent.worktreePath) return 'It works in the project folder, which has no files of its own to copy into.';
  return null;
}

/** What copying the legacy defaults into an existing plain agent would do. Writes nothing. */
export async function previewCopyIntoAgent(projectPath: string, agentId: string): Promise<LegacyCopyPreview> {
  const agent = await plainAgentFor(projectPath, agentId);
  const provider = await resolveOrchestrator(projectPath, agent.orchestrator);
  const blocked = blockedReason(agent);
  if (blocked) return { agentName: agent.name, cli: provider.displayName, changes: [], blocked };
  const { changes } = await planCopy(projectPath, agent, provider, await readProjectAgentDefaults(projectPath), folderReader(agent.worktreePath!));
  return { agentName: agent.name, cli: provider.displayName, changes, blocked: null };
}

/** Copy the legacy defaults into an existing plain agent. Returns what was done. */
export async function copyIntoAgent(projectPath: string, agentId: string): Promise<LegacyCopyPreview> {
  const agent = await plainAgentFor(projectPath, agentId);
  const provider = await resolveOrchestrator(projectPath, agent.orchestrator);
  const blocked = blockedReason(agent);
  if (blocked) throw new Error(blocked);
  const plan = await planCopy(projectPath, agent, provider, await readProjectAgentDefaults(projectPath), folderReader(agent.worktreePath!));
  const { updateDurableConfig } = await agentConfig();
  await plan.apply((fields) => updateDurableConfig(projectPath, agentId, fields));
  appLog(LOG_NS, 'info', 'Copied the project\'s legacy defaults into a plain agent', {
    meta: { agentId, changes: plan.changes.map((c) => `${c.item}:${c.action}`) },
  });
  return { agentName: agent.name, cli: provider.displayName, changes: plan.changes, blocked: null };
}

/**
 * What the New agent page's copy would do for an agent on `orchestrator`
 * named `name`, in a new worktree. The worktree doesn't exist yet, so this
 * reads the files git will check out for it: the copy then finds the same
 * files and adds to them as previewed. Writes nothing.
 */
export async function previewCopyIntoNewAgent(projectPath: string, name: string, orchestrator?: string): Promise<LegacyCopyPreview> {
  const provider = await resolveOrchestrator(projectPath, orchestrator);
  const draft: DurableAgentConfig = {
    id: 'new', name, color: 'gray', createdAt: new Date().toISOString(),
    ...(orchestrator && { orchestrator: orchestrator as never }),
    worktreePath: path.join(projectPath, '.clubhouse', 'agents', name),
    branch: `${name}/standby`,
  };
  const read = await newWorktreeReader(projectPath, draft.branch!);
  const { changes } = await planCopy(projectPath, draft, provider, await readProjectAgentDefaults(projectPath), read);
  return { agentName: name, cli: provider.displayName, changes, blocked: null };
}

/**
 * Copy the legacy defaults into a new agent's worktree during its creation,
 * when the person asked for it (agent-config's `copyLegacyDefaults`).
 */
export async function copyIntoNewAgent(
  projectPath: string,
  agent: DurableAgentConfig,
  saveCommands: (fields: Commands) => Promise<void>,
): Promise<void> {
  if (!agent.worktreePath) return;
  const defaults = await readProjectAgentDefaults(projectPath);
  if (!hasLegacyAgentDefaults(defaults)) return;
  const provider = await resolveOrchestrator(projectPath, agent.orchestrator);
  const plan = await planCopy(projectPath, agent, provider, defaults, folderReader(agent.worktreePath));
  await plan.apply(saveCommands);
}

// ── Import as parts ──────────────────────────────────────────────────────

interface ImportPlan {
  block: { name: string; content: string } | null;
  mcps: Array<{ name: string; content: ManagedMcpContent }>;
  /** What each plugin had saved here, which becomes that plugin's parts (#3245). */
  plugins: Map<string, { instructions?: string; mcpServers?: Record<string, unknown> }>;
  notes: string[];
}

/**
 * The plugin a saved `plugin-<id>-<name>` server is from. A plugin id can hold
 * dashes, so an id already known from an instruction block or a rule tag wins
 * (the longest that fits), else the shortest one.
 */
function pluginOfServerAmong(key: string, known: Set<string>): string | undefined {
  const fits = [...known].filter((id) => key.startsWith(`plugin-${id}-`) && key.length > `plugin-${id}-`.length);
  if (fits.length > 0) return fits.sort((a, b) => b.length - a.length)[0];
  return pluginOfServer(key);
}

async function projectName(projectPath: string): Promise<string> {
  try {
    const { list } = await import('./project-store');
    const { isSameProject } = await agentConfig();
    for (const p of await list()) if (await isSameProject(p.path, projectPath)) return p.displayName || p.name;
  } catch {
    // telemetry-exempt: the folder name is used instead
  }
  return path.basename(projectPath);
}

/** The project's commands written into the block text: what it referenced filled in, the rest listed. */
function blockText(instructions: string, commands: Commands, scp: string | undefined): string {
  let text = instructions;
  if (scp) text = text.replace(/@@SourceControlProvider/g, scp);
  const listed: string[] = [];
  for (const key of COMMAND_KEYS) {
    const value = commands[key];
    if (!value) continue;
    const token = `@@${COMMAND_NAMES[key]}Command`;
    if (text.includes(token)) text = text.split(token).join(value);
    else listed.push(`- ${COMMAND_NAMES[key]}: \`${value}\``);
  }
  if (listed.length > 0) text = `${text.trim()}${text.trim() ? '\n\n' : ''}## Project commands\n\n${listed.join('\n')}`;
  return text.trim();
}

async function planImport(projectPath: string): Promise<ImportPlan> {
  const defaults = await readProjectAgentDefaults(projectPath);
  const { validatePayload, adoptNativeMcpServer } = await import('./asset-catalog/validation');
  const { refusal, envAsNames, leftoverWildcards } = await import('./managed-agents/agents');
  const notes: string[] = [];
  const name = await projectName(projectPath);
  const { own, plugins: pluginBlocks } = userInstructionsOf(defaults.instructions ?? '');
  const plugins: ImportPlan['plugins'] = new Map();
  const pluginEntry = (id: string) => plugins.get(id) ?? plugins.set(id, {}).get(id)!;
  for (const p of pluginBlocks) {
    if (!p.text) continue;
    // Only a real plugin id can own a part; a hand-edited marker stays as saved.
    if (isValidPluginId(p.pluginId)) pluginEntry(p.pluginId).instructions = p.text;
    else notes.push(`The block marked for "${p.pluginId}" isn't imported, since that isn't a plugin id.`);
  }
  const knownPlugins = new Set([
    ...pluginBlocks.map((p) => p.pluginId),
    ...[...(defaults.permissions?.allow ?? []), ...(defaults.permissions?.deny ?? [])].map((r) => /\/\* plugin:([^ ]+) \*\//.exec(r)?.[1]).filter((id): id is string => !!id),
  ]);

  let block: ImportPlan['block'] = null;
  const scp = defaults.sourceControlProvider;
  const content = blockText(own, commandsOf(defaults), scp);
  if (content) {
    const checked = validatePayload('block', { content });
    if (checked.ok === false) {
      notes.push(`The instructions aren't imported because ${refusal(checked.issues)}.`);
    } else {
      block = { name: `${name} legacy instructions`, content };
      const leftover = leftoverWildcards(content);
      if (leftover.length > 0) notes.push(`The block still has ${leftover.join(', ')}, which a managed agent doesn't fill in. Edit it after importing.`);
    }
  }

  const mcps: ImportPlan['mcps'] = [];
  if (defaults.mcpJson?.trim()) {
    const servers = serversIn(defaults.mcpJson);
    if (servers === null) notes.push('The MCP servers aren\'t imported because the MCP JSON isn\'t valid JSON.');
    for (const [serverKey, rawDef] of Object.entries(servers ?? {})) {
      if (serverKey === 'clubhouse') continue;
      // A name that only looks like a plugin's (no valid plugin id) is the person's own server.
      const pluginId = pluginOfServerAmong(serverKey, knownPlugins);
      if (pluginId && isValidPluginId(pluginId)) {
        // The plugin's own: it becomes the plugin's part, under the server's own name.
        const entry = pluginEntry(pluginId);
        entry.mcpServers = { ...entry.mcpServers, [serverKey.slice(`plugin-${pluginId}-`.length)]: rawDef };
        continue;
      }
      const { def, dropped } = envAsNames(rawDef);
      if (dropped.length > 0) notes.push(`${serverKey}: values for ${dropped.join(', ')} aren't kept. Set them in your environment.`);
      const adopted = adoptNativeMcpServer(serverKey, def);
      if (adopted.ok === false) { notes.push(`The ${serverKey} MCP server isn't imported because ${refusal(adopted.issues)}.`); continue; }
      const p = adopted.payload;
      mcps.push({
        name: serverKey,
        content: {
          kind: 'mcp', serverKey: p.serverKey, transport: p.transport,
          ...(p.command !== undefined && { command: p.command }),
          ...(p.args && { args: [...p.args] }),
          ...(p.url !== undefined && { url: p.url }),
          ...(p.envVars && { envVars: [...p.envVars] }),
        },
      });
    }
  }
  if (defaults.permissions?.allow?.length || defaults.permissions?.deny?.length) {
    notes.push('Permission rules aren\'t parts: each CLI has its own syntax. Copy them into a plain agent, or set access on the agent or template.');
  }
  return { block, mcps, plugins, notes };
}

/** A library part with this exact content, if there is one. */
async function partInLibrary(kind: 'block' | 'mcp', content: ManagedPartContent): Promise<{ id: string; name: string } | null> {
  const { managedAgents } = await import('./managed-agents');
  const { canonicalJson } = await import('./managed-agents/agents');
  const service = managedAgents();
  const want = canonicalJson(content);
  for (const [id, entry] of Object.entries(await service.liveEntries())) {
    if (entry.kind !== kind || entry.owner.kind !== 'library') continue;
    const head = await service.headContent(id);
    if (head && canonicalJson(head.content) === want) return { id, name: entry.name };
  }
  return null;
}

/** What importing the legacy defaults as library parts would make. Writes nothing. */
export async function previewImportAsParts(projectPath: string): Promise<LegacyImportPreview> {
  const plan = await planImport(projectPath);
  const parts: LegacyImportPreview['parts'] = [];
  if (plan.block) {
    const found = await partInLibrary('block', { kind: 'block', content: plan.block.content });
    parts.push({ kind: 'block', name: found?.name ?? plan.block.name, status: found ? 'in_library' : 'new' });
  }
  for (const mcp of plan.mcps) {
    const found = await partInLibrary('mcp', mcp.content);
    parts.push({ kind: 'mcp', name: found?.name ?? mcp.name, status: found ? 'in_library' : 'new' });
  }
  if (plan.plugins.size > 0) {
    const { hasPluginPart, pluginPartName } = await import('./plugin-parts');
    const name = await projectName(projectPath);
    for (const [pluginId, saved] of plan.plugins) {
      if (saved.instructions) {
        const has = await hasPluginPart(projectPath, pluginId, { instructions: true });
        parts.push({ kind: 'block', name: pluginPartName(name, pluginId, 'instructions'), status: has ? 'in_library' : 'new', pluginId });
      }
      for (const serverKey of Object.keys(saved.mcpServers ?? {})) {
        const has = await hasPluginPart(projectPath, pluginId, { serverKey });
        parts.push({ kind: 'mcp', name: pluginPartName(name, pluginId, serverKey), status: has ? 'in_library' : 'new', pluginId });
      }
    }
  }
  return { parts, notes: plan.notes };
}

/** Import the legacy defaults as library parts. Parts already there with the same content aren't made again. */
export async function importAsParts(projectPath: string): Promise<LegacyImportResult> {
  const plan = await planImport(projectPath);
  const { managedAgents } = await import('./managed-agents');
  const { ManagedError } = await import('./managed-agents/service');
  const service = managedAgents();
  const created: LegacyImportResult['created'] = [];
  const existing: LegacyImportResult['existing'] = [];
  const description = `Imported from ${await projectName(projectPath)}'s legacy agent defaults.`;
  const make = async (kind: 'block' | 'mcp', name: string, content: ManagedPartContent) => {
    const found = await partInLibrary(kind, content);
    if (found) { existing.push({ ...found, kind }); return; }
    for (let n = 1; n < 100; n++) {
      const candidate = n === 1 ? name : `${name} ${n}`;
      try {
        const part = await service.createPart({ name: candidate, description, content, source: { kind: 'import', from: 'project-defaults' } });
        created.push({ id: part.id, kind, name: candidate });
        return;
      } catch (err) {
        if (err instanceof ManagedError && err.code === 'name_taken') continue;
        throw err;
      }
    }
  };
  if (plan.block) await make('block', plan.block.name, { kind: 'block', content: plan.block.content });
  for (const mcp of plan.mcps) await make('mcp', mcp.name, mcp.content);
  // A plugin's saved items become that plugin's parts, which it keeps up to date (#3245).
  const notes = [...plan.notes];
  const pluginParts: string[] = [];
  if (plan.plugins.size > 0) {
    const { hasPluginPart, importPluginLegacyParts, pluginPartName } = await import('./plugin-parts');
    const name = await projectName(projectPath);
    for (const [pluginId, saved] of plan.plugins) {
      const wanted: Array<[string, { instructions: true } | { serverKey: string }]> = [
        ...(saved.instructions ? [[pluginPartName(name, pluginId, 'instructions'), { instructions: true as const }] as [string, { instructions: true }]] : []),
        ...Object.keys(saved.mcpServers ?? {}).map((serverKey): [string, { serverKey: string }] => [pluginPartName(name, pluginId, serverKey), { serverKey }]),
      ];
      const before = await Promise.all(wanted.map(([, what]) => hasPluginPart(projectPath, pluginId, what)));
      const result = await importPluginLegacyParts(projectPath, pluginId, {
        ...(saved.instructions && { instructions: saved.instructions }),
        ...(saved.mcpServers && { mcpServers: saved.mcpServers }),
      });
      notes.push(...result.notes);
      // Only what this import made: a server the catalog refused is in the notes instead.
      for (const [i, [label, what]] of wanted.entries()) {
        if (!before[i] && await hasPluginPart(projectPath, pluginId, what)) pluginParts.push(label);
      }
    }
  }
  appLog(LOG_NS, 'info', 'Imported the project\'s legacy defaults as parts', {
    meta: { created: created.length, existing: existing.length, pluginParts: pluginParts.length },
  });
  return { created, existing, ...(pluginParts.length > 0 && { pluginParts }), notes };
}
