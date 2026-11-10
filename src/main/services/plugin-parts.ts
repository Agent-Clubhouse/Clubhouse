/**
 * What a plugin's agentConfig API contributes (#3245): its instructions and
 * MCP servers become Managed Agent parts in the library, attributed to the
 * plugin and the project it wrote them for, instead of the project's legacy
 * agent defaults. A person adds them to an agent or template like any part.
 *
 * Each part's catalog source names the plugin, the project and what it holds
 * (`instructions`, or `mcp:<serverKey>`), so the plugin's next write updates
 * the same part and a removal finds it. A write also clears what the plugin
 * had saved in the project's legacy defaults for the same thing, since the
 * part replaces it. A removed part that agents use stays with them as their
 * own copy, so nothing they run with goes away unasked.
 */
import * as path from 'path';
import { withPluginParts, type PluginAgentDefaultsParts } from '../../shared/plugin-agent-defaults';
import type { ManagedMcpContent, ManagedPartContent } from '../../shared/managed-agents-types';
import type { CatalogEntry } from '../../shared/asset-catalog-types';
import { updateProjectAgentDefaults } from './agent-settings-service';
import { appLog } from './log-service';
import { list as listProjects } from './project-store';
import { isSameProject } from './agent-config';
import { managedAgents } from './managed-agents';
import { canonicalJson, envAsNames, refusal } from './managed-agents/agents';
import { ManagedError } from './managed-agents/service';
import { adoptNativeMcpServer, validatePayload } from './asset-catalog/validation';

const LOG_NS = 'core:managed';

/** What a plugin sets: a key that's missing leaves that part alone, `null` removes it. */
export interface PluginManagedPartsUpdate {
  /** The plugin's instruction block. */
  instructions?: string | null;
  /** The plugin's MCP servers under their own names: each becomes one part. */
  mcpServers?: Record<string, unknown> | null;
}

export interface PluginManagedPartsResult {
  /** What wasn't made a part, and why. */
  notes: string[];
}

export interface PluginManagedParts {
  instructions: string | null;
  mcpServers: string[];
}

const INSTRUCTIONS_KEY = 'instructions';
const mcpKey = (serverKey: string) => `mcp:${serverKey}`;

async function project(projectPath: string): Promise<{ id: string; name: string }> {
  for (const p of await listProjects()) if (await isSameProject(p.path, projectPath)) return { id: p.id, name: p.displayName || p.name };
  throw new Error(`${path.basename(projectPath)} isn't a registered project.`);
}

function sourceOf(entry: CatalogEntry): { pluginId: string; projectId: string; key: string } | null {
  return entry.source.kind === 'plugin' ? entry.source : null;
}

/** This plugin's parts for this project, by key. */
async function partsOf(pluginId: string, projectId: string): Promise<Map<string, CatalogEntry>> {
  const out = new Map<string, CatalogEntry>();
  for (const entry of Object.values(await managedAgents().liveEntries())) {
    const source = sourceOf(entry);
    if (source && source.pluginId === pluginId && source.projectId === projectId) out.set(source.key, entry);
  }
  return out;
}

/** Plugin writes are queued per plugin and project, so two at once can't make two parts. */
const queues = new Map<string, Promise<unknown>>();
function queued<T>(pluginId: string, projectPath: string, fn: () => Promise<T>): Promise<T> {
  const key = `${pluginId}\0${path.resolve(projectPath)}`;
  const run = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
  queues.set(key, run.catch((): undefined => undefined));
  return run;
}

async function mcpContent(serverKey: string, raw: unknown, notes: string[]): Promise<ManagedMcpContent | null> {
  const { def, dropped } = envAsNames(raw);
  if (dropped.length > 0) notes.push(`${serverKey}: values for ${dropped.join(', ')} aren't kept. Set them in the environment.`);
  const adopted = adoptNativeMcpServer(serverKey, def);
  if (adopted.ok === false) { notes.push(`The ${serverKey} MCP server isn't made a part because ${refusal(adopted.issues)}.`); return null; }
  const p = adopted.payload;
  return {
    kind: 'mcp', serverKey: p.serverKey, transport: p.transport,
    ...(p.command !== undefined && { command: p.command }),
    ...(p.args && { args: [...p.args] }),
    ...(p.url !== undefined && { url: p.url }),
    ...(p.envVars && { envVars: [...p.envVars] }),
  };
}

/**
 * Make, update or remove one plugin part. `content` null removes it; agents
 * that use it keep their own copy.
 */
async function putPart(
  pluginId: string,
  proj: { id: string; name: string },
  key: string,
  existing: CatalogEntry | undefined,
  name: string,
  content: ManagedPartContent | null,
): Promise<void> {
  const service = managedAgents();
  const actor = `the ${pluginId} plugin`;
  if (content === null) {
    if (existing) await service.deletePart({ id: existing.id, expectedRevision: existing.headRevision, mode: 'copy' });
    return;
  }
  if (existing) {
    const head = await service.headContent(existing.id);
    if (head && canonicalJson(head.content) === canonicalJson(content)) return;
    await service.updatePart({ id: existing.id, expectedRevision: existing.headRevision, content, actor });
    return;
  }
  const description = `Contributed by the ${pluginId} plugin for ${proj.name}. The plugin keeps it up to date; make a copy to change it.`;
  for (let n = 1; n < 100; n++) {
    try {
      await service.createPart({ name: n === 1 ? name : `${name} ${n}`, description, content, actor, source: { kind: 'plugin', pluginId, projectId: proj.id, key } });
      return;
    } catch (err) {
      if (err instanceof ManagedError && err.code === 'name_taken') continue;
      throw err;
    }
  }
}

interface ApplyOptions {
  /** Clear what the plugin had in the project's legacy defaults for the same thing (a plugin's own write). */
  clearLegacy: boolean;
  /** Leave a part the plugin already has as it is, and remove none (an import of saved values). */
  onlyMissing: boolean;
}

/**
 * Set what a plugin contributes for a project as parts, and clear what it had
 * in the project's legacy defaults for the same thing.
 */
export function setPluginManagedParts(projectPath: string, pluginId: string, update: PluginManagedPartsUpdate): Promise<PluginManagedPartsResult> {
  return applyPluginParts(projectPath, pluginId, update, { clearLegacy: true, onlyMissing: false });
}

/**
 * Make parts from what a plugin saved in the project's legacy defaults before
 * #3245 (Import as parts). The saved values stay as they are, and a part the
 * plugin already has isn't touched: the plugin's next write updates it.
 */
export function importPluginLegacyParts(projectPath: string, pluginId: string, update: PluginManagedPartsUpdate): Promise<PluginManagedPartsResult> {
  return applyPluginParts(projectPath, pluginId, update, { clearLegacy: false, onlyMissing: true });
}

/** The name a plugin's part gets for a project. */
export function pluginPartName(projectName: string, pluginId: string, what: string): string {
  return `${projectName}: ${pluginId} ${what}`;
}

/** Whether the plugin already has this part for the project (`instructions`, or an MCP server key). */
export async function hasPluginPart(projectPath: string, pluginId: string, what: { instructions: true } | { serverKey: string }): Promise<boolean> {
  const proj = await project(projectPath);
  return (await partsOf(pluginId, proj.id)).has('instructions' in what ? INSTRUCTIONS_KEY : mcpKey(what.serverKey));
}

function applyPluginParts(projectPath: string, pluginId: string, update: PluginManagedPartsUpdate, opts: ApplyOptions): Promise<PluginManagedPartsResult> {
  return queued(pluginId, projectPath, async () => {
    const proj = await project(projectPath);
    const existing = await partsOf(pluginId, proj.id);
    const notes: string[] = [];
    const legacy: PluginAgentDefaultsParts = {};

    if (update.instructions !== undefined) {
      let content: ManagedPartContent | null = null;
      if (update.instructions !== null && update.instructions.trim()) {
        const checked = validatePayload('block', { content: update.instructions });
        if (checked.ok === false) throw new Error(`The instructions can't be a part because ${refusal(checked.issues)}.`);
        content = { kind: 'block', content: update.instructions };
      }
      if (!(opts.onlyMissing && (existing.has(INSTRUCTIONS_KEY) || content === null))) {
        await putPart(pluginId, proj, INSTRUCTIONS_KEY, existing.get(INSTRUCTIONS_KEY), pluginPartName(proj.name, pluginId, 'instructions'), content);
      }
      legacy.instructions = null;
    }

    if (update.mcpServers !== undefined) {
      const wanted = new Map<string, ManagedMcpContent>();
      for (const [serverKey, raw] of Object.entries(update.mcpServers ?? {})) {
        if (serverKey === 'clubhouse') { notes.push('The clubhouse server is Clubhouse\'s own, so it isn\'t made a part.'); continue; }
        const content = await mcpContent(serverKey, raw, notes);
        if (content) wanted.set(mcpKey(serverKey), content);
      }
      for (const [key, content] of wanted) {
        if (opts.onlyMissing && existing.has(key)) continue;
        await putPart(pluginId, proj, key, existing.get(key), pluginPartName(proj.name, pluginId, content.serverKey), content);
      }
      if (!opts.onlyMissing) {
        for (const [key, entry] of existing) {
          if (key.startsWith('mcp:') && !wanted.has(key)) await putPart(pluginId, proj, key, entry, entry.name, null);
        }
      }
      legacy.mcpServers = null;
    }

    if (opts.clearLegacy) await updateProjectAgentDefaults(projectPath, (current) => withPluginParts(current, pluginId, legacy));
    appLog(LOG_NS, 'info', 'A plugin set its parts for a project', {
      meta: { pluginId, instructions: update.instructions === undefined ? 'unchanged' : update.instructions === null ? 'removed' : 'set', mcpServers: update.mcpServers === undefined ? 'unchanged' : Object.keys(update.mcpServers ?? {}).length },
    });
    return { notes };
  });
}

/** What a plugin contributes for a project: its instruction text and MCP server keys. */
export async function readPluginManagedParts(projectPath: string, pluginId: string): Promise<PluginManagedParts> {
  const proj = await project(projectPath);
  const service = managedAgents();
  let instructions: string | null = null;
  const mcpServers: string[] = [];
  for (const [key, entry] of await partsOf(pluginId, proj.id)) {
    const head = await service.headContent(entry.id);
    if (key === INSTRUCTIONS_KEY && head?.content.kind === 'block') instructions = head.content.content;
    if (key.startsWith('mcp:') && head?.content.kind === 'mcp') mcpServers.push(head.content.serverKey);
  }
  return { instructions, mcpServers };
}

/** Remove every part a plugin contributed for a project, as uninstalling it does. Agents that use one keep their copy. */
export async function removeAllPluginManagedParts(projectPath: string, pluginId: string): Promise<void> {
  try {
    await setPluginManagedParts(projectPath, pluginId, { instructions: null, mcpServers: null });
  } catch (err) {
    // telemetry-exempt: uninstall cleanup is best effort, as the rest of it is
    appLog(LOG_NS, 'warn', 'Could not remove a plugin\'s parts', { meta: { pluginId, error: err instanceof Error ? err.message : String(err) } });
  }
}
