/**
 * Clubhouse-managed agents (#2819): agent parts, templates and per-agent
 * setups. Parts are asset catalog entries used by reference; this service
 * adds what the catalog doesn't model (descriptions, forks with "back to
 * shared", consumers across projects, unlinked templates) and keeps the
 * agent configs' `managed` setups in step.
 *
 * Everything the UI and the builder MCP tools do goes through here, so the
 * two can't drift (#2900).
 */
import { nameIssues } from '../asset-catalog/validation';
import { ACCESS_LEVELS, accessLabel, isAccessLevel, withAccess } from '../../../shared/agent-access';
import { agentAccess, getDefaultAccess, getPermissionMode } from '../free-agent-settings';
import { canonicalHash } from '../asset-catalog/planner';
import { AssetCatalogError, installBuiltinAsset, removeBuiltinAsset, type AssetCatalogStore } from '../asset-catalog/store';
import { auditChanged, auditChanges, currentSettingsOrigin, withSettingsSurface } from '../settings-audit';
import { appLog } from '../log-service';
import type { AssetPayload, AssetSource, BlockAssetPayload, CatalogEntry, McpAssetPayload, SkillAssetPayload } from '../../../shared/asset-catalog-types';
import type { DurableAgentConfig } from '../../../shared/types';
import { isEffortValue } from '../../../shared/agent-helpers';
import { normalizeIdleSleep } from '../../../shared/idle-sleep';
import { validateOrchestrationPatch } from '../../../shared/orchestration-policy';
import { GRANT_ACTION_LABELS, grantKey, grantTargetLabel, isFixedGrant, isHelperControlRow, normalizeTemplateGrants, type GrantChange, type TemplateGrant } from '../../../shared/agent-grant-changes';
import type { GrantAction } from '../../../shared/agent-grants';
import { carriedAgentGrants, templateLayerGrants } from '../agent-grants-service';
import {
  CLUBHOUSE_MCP_PART_ID,
  CLUBHOUSE_PART_ALWAYS_ON,
  findSkillFolderClash,
  isListed,
  type ManagedAgentSetup,
  type ManagedErrorCode,
  type ManagedHelperChanges,
  type ManagedPart,
  type ManagedPartConsumer,
  type ManagedPartContent,
  type ManagedPartKind,
  type ManagedPartSummary,
  type ManagedTemplate,
  type ManagedTemplateChange,
  type ManagedTemplatePushTarget,
  type ManagedTemplateSettings,
  skillFolderClashMessage,
} from '../../../shared/managed-agents-types';
import { builtinParts, builtinTemplates, DEFAULT_HELPER_TEMPLATE_ID, type BuiltinPart } from './builtins';
import type { ManagedStateStore } from './state-store';
import type { ManagedRestartReceipt } from './activation-receipts';

export class ManagedError extends Error {
  constructor(readonly code: ManagedErrorCode, message?: string) {
    super(message ?? code);
  }
}

export interface ManagedPartCreationReceipt {
  partId: string;
  revision: number;
  catalog: 'committed';
  metadata: 'saved' | 'not_saved';
  unfinishedStage: 'metadata' | 'readback';
  recovery: string;
}

export class ManagedPartCreationError extends ManagedError {
  constructor(readonly receipt: ManagedPartCreationReceipt) {
    super('failed', `Library part ${receipt.partId} was created, but ${receipt.unfinishedStage} did not finish. Do not retry creation. ${receipt.recovery}`);
  }
}

export interface ManagedAgentsDeps {
  catalog: AssetCatalogStore;
  state: ManagedStateStore;
  listProjects(): Promise<Array<{ path: string; name: string }>>;
  listAgents(projectPath: string): Promise<readonly DurableAgentConfig[]>;
  getAgent(projectPath: string, agentId: string): Promise<DurableAgentConfig | null>;
  setManagedSetup(projectPath: string, agentId: string, setup: ManagedAgentSetup | null, precondition?: import('../agent-config').ManagedSetupCommitPrecondition): Promise<void>;
  isRunning(agentId: string): boolean;
  /** Called after anything that may change what an agent gets, so the UI can refresh. */
  onChanged?(): void;
  /** Called after an agent stops being managed, to remove what Clubhouse added to its folder for itself. Never throws. */
  onUnmanaged?(projectPath: string, agent: DurableAgentConfig): Promise<void>;
  /** Like listProjects, saying whether the list could be read. Retired built-ins are removed only when it could (D99). */
  listProjectsChecked?(): Promise<{ projects: Array<{ path: string; name: string }>; readable: boolean }>;
  /** Like listAgents, saying whether the project's agents could be read (D99). */
  listAgentsChecked?(projectPath: string): Promise<{ agents: readonly DurableAgentConfig[]; readable: boolean }>;
  /** Set an agent's own helper template, when a retired built-in template it names becomes a copy (D99). */
  setHelperTemplate?(projectPath: string, agentId: string, templateId: string): Promise<void>;
  /**
   * Called after a retired built-in in an agent's setup was swapped for its
   * copy (D99), with the setup before and after. Delivery is the same, so a
   * running session's record can follow and no setup-changed bar shows.
   */
  onSetupRemapped?(projectPath: string, agent: DurableAgentConfig, before: ManagedAgentSetup, after: ManagedAgentSetup): Promise<void>;
}

const KINDS: ManagedPartKind[] = ['block', 'skill', 'mcp'];
const BUILTINS = new Map(builtinParts().map((p) => [p.id, p]));
const BUILTIN_TEMPLATES = new Map(builtinTemplates().map((t) => [t.id, t]));

function isKind(kind: string): kind is ManagedPartKind {
  return (KINDS as string[]).includes(kind);
}

export function emptySetup(): ManagedAgentSetup {
  return { version: 1, blocks: [], skills: [], mcps: [] };
}

/**
 * The Clubhouse MCP part is in every managed setup and template, first, and
 * can't be left out: the Clubhouse MCP always runs (the maintainer, 2026-11-07).
 */
export function withClubhousePart(mcps: readonly string[]): string[] {
  return mcps.includes(CLUBHOUSE_MCP_PART_ID) ? [...mcps] : [CLUBHOUSE_MCP_PART_ID, ...mcps];
}

/**
 * A saved setup as every reader sees it: one saved before the part was
 * required reads as having it, so the delivery fingerprint, status, "used
 * by" counts and get_agent_setup all agree with what the next save writes.
 */
export function withClubhouseSetup(setup: ManagedAgentSetup): ManagedAgentSetup {
  return setup.mcps.includes(CLUBHOUSE_MCP_PART_ID) ? setup : { ...setup, mcps: withClubhousePart(setup.mcps) };
}

function withClubhousePartIn<T extends { setup: { blocks: string[]; skills: string[]; mcps: string[] } }>(t: T): T {
  return t.setup.mcps.includes(CLUBHOUSE_MCP_PART_ID) ? t : { ...t, setup: { ...t.setup, mcps: withClubhousePart(t.setup.mcps) } };
}

/**
 * Who a write is attributed to when it isn't the person (D90): the caller's
 * own name for it, else "Dispatcher" for a write that runs under the
 * Dispatcher's surface (its builder tools), else nobody.
 */
export function actorOf(explicit?: string): string | undefined {
  if (explicit) return explicit;
  return currentSettingsOrigin().surface === 'dispatcher' ? 'Dispatcher' : undefined;
}

function sameParts(a: Pick<ManagedAgentSetup, 'blocks' | 'skills' | 'mcps'>, b: Pick<ManagedAgentSetup, 'blocks' | 'skills' | 'mcps'>): boolean {
  const key = (x: Pick<ManagedAgentSetup, 'blocks' | 'skills' | 'mcps'>) => JSON.stringify([x.blocks, x.skills, withClubhousePart(x.mcps)]);
  return key(a) === key(b);
}

function listOf(setup: ManagedAgentSetup, kind: ManagedPartKind): string[] {
  return kind === 'block' ? setup.blocks : kind === 'skill' ? setup.skills : setup.mcps;
}

function replaceIn(setup: ManagedAgentSetup, from: string, to: string | null): ManagedAgentSetup {
  const swap = (ids: string[]) => {
    const out: string[] = [];
    for (const id of ids) {
      const next = id === from ? to : id;
      if (next && !out.includes(next)) out.push(next);
    }
    return out;
  };
  return { ...setup, blocks: swap(setup.blocks), skills: swap(setup.skills), mcps: swap(setup.mcps) };
}

/**
 * A part's content as Clubhouse uses it. `droppedEnvValues` names the MCP
 * env entries that were stored with literal values: those values are no
 * longer used, so the person must set them in their environment (D46).
 */
function payloadToContent(kind: ManagedPartKind, payload: AssetPayload): { content: ManagedPartContent; droppedEnvValues: string[] } {
  if (kind === 'block') return { content: { kind, content: (payload as BlockAssetPayload).content }, droppedEnvValues: [] };
  if (kind === 'skill') {
    const p = payload as SkillAssetPayload;
    return { content: { kind, skillName: p.skillName, files: p.files.map((f) => ({ ...f })) }, droppedEnvValues: [] };
  }
  const p = payload as McpAssetPayload;
  // Env values never leave the catalog (D46): a part saved with literal values
  // reads, forks and delivers as their names, taken from the signed-in environment.
  const droppedEnvValues = Object.keys(p.env ?? {});
  const envVars = [...new Set([...(p.envVars ?? []), ...droppedEnvValues])];
  return {
    content: {
      kind,
      serverKey: p.serverKey,
      transport: p.transport,
      ...(p.command !== undefined && { command: p.command }),
      ...(p.args && { args: [...p.args] }),
      ...(p.url !== undefined && { url: p.url }),
      ...((p.envVars || envVars.length > 0) && { envVars }),
    },
    droppedEnvValues,
  };
}

/** Managed MCP parts keep env names only. Values come from the person's signed-in environment. */
function refuseEnvValues(content: ManagedPartContent | undefined): void {
  if (content?.kind !== 'mcp' || !content.env) return;
  const names = Object.keys(content.env);
  if (names.length === 0) return;
  throw new ManagedError('invalid', `MCP servers keep variable names only, never values. List ${names.join(', ')} under Environment (envVars) and set the values in your environment.`);
}

function contentToPayload(content: ManagedPartContent): AssetPayload {
  if (content.kind === 'block') return { content: content.content };
  if (content.kind === 'skill') return { skillName: content.skillName, files: content.files.map((f) => ({ ...f })) };
  return {
    serverKey: content.serverKey,
    transport: content.transport,
    ...(content.command !== undefined && { command: content.command }),
    ...(content.args && { args: content.args }),
    ...(content.url !== undefined && { url: content.url }),
    ...(content.envVars && content.envVars.length > 0 && { envVars: content.envVars }),
    ...(content.env && Object.keys(content.env).length > 0 && { env: content.env }),
  } as McpAssetPayload;
}

function previewOf(content: ManagedPartContent): string {
  if (content.kind === 'block') return content.content.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (content.kind === 'skill') return `${content.files.length} file${content.files.length === 1 ? '' : 's'}: ${content.files.map((f) => f.path).slice(0, 4).join(', ')}`;
  return content.transport === 'stdio' ? [content.command, ...(content.args ?? [])].filter(Boolean).join(' ') : content.url ?? '';
}

function mapCatalogError(err: unknown): never {
  if (err instanceof ManagedError) throw err;
  if (err instanceof AssetCatalogError) {
    const code: string = err.code;
    if (code === 'stale_revision' || code === 'stale_name') throw new ManagedError('stale', 'It changed since you opened it.');
    if (code === 'builtin_read_only') throw new ManagedError('builtin_read_only');
    if (code === 'asset_missing' || code === 'asset_deleted' || code === 'not_found') throw new ManagedError('not_found');
    if (code === 'invalid_payload' || code === 'reserved_namespace') throw new ManagedError('invalid', 'Check the name, paths and fields.');
    if (code === 'agent_not_permitted') throw new ManagedError('not_permitted');
    if (code === 'asset_in_use') throw new ManagedError('in_use');
  }
  throw err;
}

/**
 * A settings-audit row for a library write (#2671, D13). Only the key and the
 * id: never a name, description, instruction text or MCP value. Who asked comes
 * from the surface the call runs under. The write has happened by now, so a
 * record that can't be written is logged and never fails it.
 */
async function auditManaged(key: string, targetId?: string): Promise<void> {
  try {
    await auditChanged('app', key, targetId);
  } catch (err) {
    // telemetry-exempt: the change it describes has happened, and the log says the record is missing
    appLog('core:managed', 'warn', 'Could not record a managed agents write', { meta: { key, error: err instanceof Error ? err.message : String(err) } });
  }
}

/** An app-wide managed setting, with its old and new value when the value is one to keep. */
async function auditManagedSetting(key: string, before: unknown, after: unknown): Promise<void> {
  try {
    await auditChanges('app', 'managed', undefined, { [key]: before }, { [key]: after }, { [key]: 'value' });
  } catch (err) {
    // telemetry-exempt: the change it describes has happened, and the log says the record is missing
    appLog('core:managed', 'warn', 'Could not record a managed setting change', { meta: { key, error: err instanceof Error ? err.message : String(err) } });
  }
}

export function createManagedAgentsService(deps: ManagedAgentsDeps) {
  const { catalog, state } = deps;
  const changed = () => { try { deps.onChanged?.(); } catch { /* telemetry-exempt: a refresh listener never fails a write */ } };

  async function liveEntries(): Promise<Record<string, CatalogEntry>> {
    const index = await catalog.read();
    const out: Record<string, CatalogEntry> = {};
    for (const [id, entry] of Object.entries(index.assets)) {
      if (!entry.deletedAt && isKind(entry.kind)) out[id] = entry;
    }
    return out;
  }

  async function entryOf(id: string): Promise<CatalogEntry> {
    const entries = await liveEntries();
    const entry = entries[id];
    if (!entry) throw new ManagedError('not_found');
    return entry;
  }

  async function readHead(entry: CatalogEntry): Promise<{ content: ManagedPartContent; droppedEnvValues: string[] }> {
    const payload = await catalog.readRevision(entry.id, entry.headRevision);
    return payloadToContent(entry.kind as ManagedPartKind, payload);
  }

  async function contentOf(entry: CatalogEntry): Promise<ManagedPartContent> {
    return (await readHead(entry)).content;
  }

  /** Every agent with a managed setup, across registered projects. */
  async function managedAgents(): Promise<Array<{ projectPath: string; projectName: string; agent: DurableAgentConfig }>> {
    const out: Array<{ projectPath: string; projectName: string; agent: DurableAgentConfig }> = [];
    for (const project of await deps.listProjects()) {
      let agents: readonly DurableAgentConfig[] = [];
      try {
        agents = await deps.listAgents(project.path);
      } catch {
        // telemetry-exempt: an unreadable project just lists no agents here.
        continue;
      }
      for (const agent of agents) {
        if (agent.managed && !agent.disposedAt) {
          out.push({ projectPath: project.path, projectName: project.name, agent: { ...agent, managed: withClubhouseSetup(agent.managed) } });
        }
      }
    }
    return out;
  }

  async function consumersOf(id: string): Promise<ManagedPartConsumer[]> {
    const all = await managedAgents();
    return all
      .filter(({ agent }) => KINDS.some((k) => listOf(agent.managed!, k).includes(id)))
      .map(({ projectPath, projectName, agent }) => ({
        projectPath, projectName, agentId: agent.id, agentName: agent.name, color: agent.color, running: deps.isRunning(agent.id),
      }));
  }

  /** Setting values as the push dialog shows them, with helper templates by name. */
  async function templateLabeler(): Promise<SettingLabeler> {
    const names = new Map((await allTemplates()).map((t) => [t.id, t.name]));
    return labelerFor((tid) => names.get(tid));
  }

  async function allTemplates(): Promise<ManagedTemplate[]> {
    const s = await state.read();
    // A custom template saved before the Clubhouse part was required reads as having it.
    // Retired built-in templates are gone: what used one has its own copy (D99).
    // A template saved before #2761 keeps its level: Free Agent Mode on reads with the app's old mode.
    return [...BUILTIN_TEMPLATES.values()].filter(isListed).concat(Object.values(s.templates).map(withClubhousePartIn))
      .map((t) => ({ ...t, settings: withAccess(t.settings, getPermissionMode()) }));
  }

  async function summarize(entry: CatalogEntry, consumers?: ManagedPartConsumer[], templates?: ManagedTemplate[]): Promise<ManagedPartSummary> {
    const kind = entry.kind as ManagedPartKind;
    const builtin = entry.source.kind === 'builtin';
    const s = await state.read();
    const meta = s.parts[entry.id] ?? {};
    const { content, droppedEnvValues } = await readHead(entry);
    const head = entry.revisions[entry.revisions.length - 1];
    const usedBy = consumers ?? await consumersOf(entry.id);
    const tpls = (templates ?? await allTemplates()).filter((t) => listOf({ version: 1, ...t.setup }, kind).includes(entry.id));
    const live = await liveEntries();
    return {
      id: entry.id,
      kind,
      name: entry.name,
      description: builtin ? (BUILTINS.get(entry.id)?.description ?? '') : (meta.description ?? ''),
      builtin,
      ...(builtin && BUILTINS.get(entry.id)?.retired && { retired: true as const }),
      ...(!builtin && meta.fromRetiredBuiltin && { fromRetiredBuiltin: true as const }),
      revision: entry.headRevision,
      updatedAt: head?.savedAt ?? entry.createdAt,
      ...(meta.updatedBy && { updatedBy: meta.updatedBy }),
      ...(meta.forkedFrom && live[meta.forkedFrom] && { forkedFrom: meta.forkedFrom }),
      usedBy,
      templates: tpls.map((t) => ({ id: t.id, name: t.name })),
      preview: previewOf(content),
      ...(content.kind === 'skill' && { skillName: content.skillName }),
      ...(droppedEnvValues.length > 0 && { droppedEnvValues }),
    };
  }

  /** Each skill's library name and the folder it installs to. */
  async function skillFolders(ids: string[], live: Record<string, CatalogEntry>): Promise<Array<{ name: string; skillName: string }>> {
    const out: Array<{ name: string; skillName: string }> = [];
    for (const id of ids) {
      const content = await contentOf(live[id]);
      if (content.kind === 'skill') out.push({ name: live[id].name, skillName: content.skillName });
    }
    return out;
  }

  async function uniqueName(kind: ManagedPartKind, wanted: string, exceptId?: string): Promise<string> {
    // A retired built-in's name is free (D71): its copy takes the same name (D99).
    const names = new Set(Object.values(await liveEntries()).filter((e) => e.kind === kind && e.id !== exceptId && !isRetiredBuiltin(e)).map((e) => e.name.toLowerCase()));
    if (!names.has(wanted.toLowerCase())) return wanted;
    for (let n = 2; n < 1000; n++) {
      const candidate = `${wanted} ${n}`;
      if (!names.has(candidate.toLowerCase())) return candidate;
    }
    return `${wanted} ${Date.now()}`;
  }

  /**
   * Every setup write goes through here. It stamps when and, for a write that
   * isn't the person's, who (D90). A helper's start_helper changes are kept
   * while its parts stay as they were, and dropped once they change (D91).
   */
  async function writeAgentSetup(
    projectPath: string,
    agentId: string,
    setup: ManagedAgentSetup,
    opts: { before?: DurableAgentConfig | null; helperChanges?: ManagedHelperChanges; actor?: string; precondition?: import('../agent-config').ManagedSetupCommitPrecondition } = {},
  ): Promise<ManagedAgentSetup> {
    const before = opts.before !== undefined ? opts.before : await deps.getAgent(projectPath, agentId);
    const kept = before?.managed?.helperChanges && sameParts(before.managed, setup) ? before.managed.helperChanges : undefined;
    const helperChanges = opts.helperChanges ?? kept;
    const actor = actorOf(opts.actor);
    const written: ManagedAgentSetup = {
      version: 1,
      blocks: setup.blocks,
      skills: setup.skills,
      mcps: setup.mcps,
      ...(setup.templateId && { templateId: setup.templateId }),
      ...(helperChanges && (helperChanges.added.length > 0 || helperChanges.removed.length > 0) && { helperChanges }),
      updatedAt: new Date().toISOString(),
      ...(actor && { updatedBy: actor }),
    };
    if (opts.precondition) await deps.setManagedSetup(projectPath, agentId, written, opts.precondition);
    else await deps.setManagedSetup(projectPath, agentId, written);
    return written;
  }

  /**
   * Write an agent's setup with a retired built-in swapped for its copy. What
   * start_helper changed (D91) follows the swap, so the line in Details stays.
   */
  async function rewriteSetup(projectPath: string, agent: DurableAgentConfig, next: ManagedAgentSetup, from: string, to: string): Promise<void> {
    const before = agent.managed!;
    const swap = (ids: string[]) => ids.map((x) => (x === from ? to : x));
    const helperChanges = before.helperChanges && { added: swap(before.helperChanges.added), removed: swap(before.helperChanges.removed) };
    const written = await writeAgentSetup(projectPath, agent.id, next, { before: agent, ...(helperChanges && { helperChanges }) });
    await deps.onSetupRemapped?.(projectPath, agent, before, written);
  }

  /** `wanted`, or with a number after it when a listed template already has that name. */
  function freeName(wanted: string, taken: Set<string>): string {
    if (!taken.has(wanted.toLowerCase())) return wanted;
    for (let n = 2; n < 1000; n++) if (!taken.has(`${wanted} ${n}`.toLowerCase())) return `${wanted} ${n}`;
    return `${wanted} ${Date.now()}`;
  }

  /**
   * Built-ins an app update retired become the person's own copies (D99,
   * revising D71). Every agent and custom template that uses a retired
   * built-in part or template switches to a custom copy with the same name
   * and content, marked as coming from a retired built-in, visible and
   * editable in the library. A retired built-in part nothing uses is
   * removed, and a retired built-in template is no longer listed. Runs with
   * every built-in install, so a later update's retirements are handled the
   * same way; once a retired built-in is gone there is nothing left to do.
   * The copy holds the same text, so what an agent is delivered doesn't
   * change. While a project's agents can't be read, the retired parts stay
   * installed, so none of its agents loses one; a later start tries again.
   */
  async function adoptRetiredBuiltins(): Promise<void> {
    const retiredParts = [...BUILTINS.values()].filter((p) => p.retired);
    const retiredTemplates = [...BUILTIN_TEMPLATES.values()].filter((t) => t.retired);
    if (retiredParts.length === 0 && retiredTemplates.length === 0) return;

    // "No agents" and "couldn't read them" differ here: a project that couldn't be read keeps the retired parts.
    const registered = deps.listProjectsChecked ? await deps.listProjectsChecked() : { projects: await deps.listProjects(), readable: true };
    let incomplete = !registered.readable;
    const agents: Array<{ projectPath: string; agent: DurableAgentConfig }> = [];
    for (const project of registered.projects) {
      try {
        const read = deps.listAgentsChecked ? await deps.listAgentsChecked(project.path) : { agents: await deps.listAgents(project.path), readable: true };
        if (!read.readable) incomplete = true;
        for (const agent of read.agents) agents.push({ projectPath: project.path, agent });
      } catch (err) {
        // telemetry-exempt: logged below with the other unreadable projects; the retired parts stay installed.
        incomplete = true;
        appLog('core:managed', 'warn', 'Could not read a project\'s agents while adopting retired built-ins', { meta: { error: err instanceof Error ? err.message : String(err) } });
      }
    }
    if (incomplete) appLog('core:managed', 'warn', 'Some projects or their agents could not be read; retired built-ins stay installed until they can', { meta: { projects: registered.projects.length } });
    const current = new Map(agents.map(({ projectPath, agent }) => [`${projectPath}\0${agent.id}`, { projectPath, agent }]));
    const s0 = await state.read();
    const copies: Record<string, string> = { ...(s0.retiredCopies ?? {}) };

    // ── Templates first, so a template copy's parts are switched with the rest below ──
    for (const t of retiredTemplates) {
      const madeFrom = agents.filter(({ agent }) => agent.managed?.templateId === t.id);
      const helperOf = agents.filter(({ agent }) => agent.helperTemplateId === t.id);
      const s = await state.read();
      const inTemplates = Object.values(s.templates).some((x) => x.settings.helperTemplateId === t.id);
      const isDefault = s.defaultHelperTemplateId === t.id;
      if (madeFrom.length === 0 && helperOf.length === 0 && !inTemplates && !isDefault) continue;
      let copyId = copies[t.id] && s.templates[copies[t.id]] ? copies[t.id] : null;
      if (!copyId) {
        const id = `template-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
        await state.update((st) => {
          const taken = new Set([...BUILTIN_TEMPLATES.values(), ...Object.values(st.templates)].filter((x) => isListed(x)).map((x) => x.name.toLowerCase()));
          st.templates[id] = {
            id, name: freeName(t.name, taken), description: t.description, builtin: false,
            setup: structuredClone(t.setup), settings: structuredClone(t.settings),
            updatedAt: new Date().toISOString(), fromRetiredBuiltin: t.id,
          };
          st.retiredCopies = { ...(st.retiredCopies ?? {}), [t.id]: id };
        });
        await auditManaged('managed.template.saved', id);
        copyId = id;
        copies[t.id] = id;
      }
      await state.update((st) => {
        for (const x of Object.values(st.templates)) if (x.settings.helperTemplateId === t.id) x.settings.helperTemplateId = copyId!;
        if (st.defaultHelperTemplateId === t.id) st.defaultHelperTemplateId = copyId!;
      });
      for (const { projectPath, agent } of madeFrom) {
        const fresh = await deps.getAgent(projectPath, agent.id);
        if (!fresh?.managed || fresh.managed.templateId !== t.id) continue;
        await rewriteSetup(projectPath, fresh, { ...fresh.managed, templateId: copyId! }, t.id, copyId!);
      }
      for (const { projectPath, agent } of helperOf) await deps.setHelperTemplate?.(projectPath, agent.id, copyId);
      appLog('core:managed', 'info', 'A retired built-in template became a custom copy', { meta: { builtinId: t.id, copyId, agents: madeFrom.length + helperOf.length } });
    }

    // ── Parts ──
    const live = await liveEntries();
    const listed = [...BUILTIN_TEMPLATES.values()].filter((t) => isListed(t));
    for (const part of retiredParts) {
      // A built-in template still offered can't change, so the part it lists stays installed.
      if (listed.some((t) => listOf({ version: 1, ...t.setup }, part.kind).includes(part.id))) {
        appLog('core:managed', 'warn', 'A retired built-in part is still in a built-in template; it stays', { meta: { id: part.id } });
        continue;
      }
      const entry = live[part.id];
      const users = [...current.values()].filter(({ agent }) => agent.managed && listOf(agent.managed, part.kind).includes(part.id));
      const s = await state.read();
      const inTemplates = Object.values(s.templates).some((t) => listOf({ version: 1, ...t.setup }, part.kind).includes(part.id));
      if (users.length > 0 || inTemplates) {
        // What agents get now: the installed text, or the shipped text when it was never installed here.
        const payload = entry ? await catalog.readRevision(entry.id, entry.headRevision) : part.payload;
        let copyId = copies[part.id] && live[copies[part.id]] ? copies[part.id] : null;
        // An older build installed the built-in again and something uses it (D100): the earlier copy is
        // the one only while it still has that text, so an edited copy never changes another agent's text.
        if (copyId) {
          const copied = await catalog.readRevision(copyId, live[copyId].headRevision).catch((): null => null);
          if (!copied || canonicalHash(copied) !== canonicalHash(payload)) copyId = null;
        }
        if (!copyId) {
          // A copy made before the app stopped, and never recorded: it is this one, so it isn't made twice.
          const cutShort = (await state.read()).retiredPending?.[part.id];
          const orphan = cutShort && Object.values(live).find((e) => e.kind === part.kind && e.source.kind !== 'builtin'
            && e.name === cutShort.name && e.createdAt >= cutShort.at && !s.parts[e.id]);
          let made = false;
          if (orphan) {
            copyId = orphan.id;
          } else {
            const name = await uniqueName(part.kind, part.name);
            // The intent first: the catalog commits the copy before managed state can say what it is.
            await state.update((st) => { st.retiredPending = { ...(st.retiredPending ?? {}), [part.id]: { name, at: new Date().toISOString() } }; });
            copyId = (await catalog.createAsset({ kind: part.kind, name, payload: payload as AssetPayload })).id;
            made = true;
          }
          const id = copyId;
          await state.update((st) => {
            st.parts[id] = { ...(part.description && { description: part.description }), fromRetiredBuiltin: part.id };
            st.retiredCopies = { ...(st.retiredCopies ?? {}), [part.id]: id };
            if (st.retiredPending) delete st.retiredPending[part.id];
          });
          if (made) await auditManaged('managed.part.created', id);
          copies[part.id] = id;
        }
        for (const { projectPath, agent } of users) {
          const fresh = await deps.getAgent(projectPath, agent.id);
          if (!fresh?.managed || !listOf(fresh.managed, part.kind).includes(part.id)) continue;
          await rewriteSetup(projectPath, fresh, replaceIn(fresh.managed, part.id, copyId), part.id, copyId!);
        }
        await state.update((st) => {
          for (const t of Object.values(st.templates)) {
            const swap = (ids: string[]) => ids.map((x) => (x === part.id ? copyId! : x)).filter((x, i, all) => all.indexOf(x) === i);
            t.setup = { blocks: swap(t.setup.blocks), skills: swap(t.setup.skills), mcps: swap(t.setup.mcps) };
          }
        });
        appLog('core:managed', 'info', 'A retired built-in part became a custom copy', { meta: { builtinId: part.id, copyId, agents: users.length } });
      }
      if (entry && !incomplete) {
        try {
          await removeBuiltinAsset(catalog, { assetId: part.id, expectedRevision: entry.headRevision });
          await auditManaged('managed.part.deleted', part.id);
        } catch (err) {
          // telemetry-exempt: logged with the catalog's code; it stays installed and hidden, and a later start tries again.
          appLog('core:managed', 'warn', 'A retired built-in part could not be removed; it stays hidden', { meta: { id: part.id, code: err instanceof AssetCatalogError ? err.code : 'unknown' } });
        }
      }
    }
  }

  const api = {
    async latestRestartReceipt(agentId: string): Promise<ManagedRestartReceipt | null> {
      const mine = (await state.read()).restarts?.filter((r) => r.agentId === agentId);
      return mine?.[mine.length - 1] ?? null;
    },

    async recordRestartReceipt(receipt: ManagedRestartReceipt): Promise<void> {
      await state.update((s) => {
        const history = s.restarts ?? [];
        const index = history.findIndex((r) => r.id === receipt.id);
        if (index >= 0) history[index] = structuredClone(receipt);
        else history.push(structuredClone(receipt));
        s.restarts = history.slice(-100);
      });
    },

    /** Install or update the built-in parts. Startup only: runs as Clubhouse itself. */
    async ensureBuiltins(): Promise<void> {
      // One bad built-in is logged and skipped, so the rest still install; the call fails at the end so a later start retries.
      const failed: string[] = [];
      await withSettingsSurface('system', undefined, async () => {
        const index = await catalog.read();
        for (const part of BUILTINS.values()) {
          // A retired built-in is never installed or updated: what uses it gets its own copy below (D99).
          if (part.retired) continue;
          const existing = index.assets[part.id];
          if (existing && existing.source.kind !== 'builtin') continue;
          if (existing && !existing.deletedAt) {
            const current = await catalog.readRevision(part.id, existing.headRevision).catch((): null => null);
            if (current && existing.name === part.name && canonicalHash(current) === canonicalHash(part.payload)) continue;
          }
          try {
            await installBuiltinAsset(catalog, {
              assetId: part.id, kind: part.kind, name: part.name, builtinId: part.id,
              expectedRevision: existing?.headRevision ?? 0, payload: part.payload,
            });
          } catch (err) {
            // telemetry-exempt: logged with the built-in's id and the catalog's code; the call throws once every part was tried.
            failed.push(part.id);
            appLog('core:managed', 'error', 'A built-in agent part could not be installed; skipped', { meta: { id: part.id, code: err instanceof AssetCatalogError ? err.code : 'unknown' } });
          }
        }
        try {
          await adoptRetiredBuiltins();
        } catch (err) {
          // telemetry-exempt: logged with the catalog's code; the call throws so a later start tries again.
          failed.push('retired built-ins');
          appLog('core:managed', 'error', 'Retired built-ins could not become custom copies', { meta: { code: err instanceof AssetCatalogError ? err.code : err instanceof Error ? err.message : 'unknown' } });
        }
      });
      if (failed.length > 0) changed();
      if (failed.length > 0) throw new Error(`Built-in agent parts could not be installed: ${failed.join(', ')}`);
    },

    async listParts(kind: ManagedPartKind): Promise<ManagedPartSummary[]> {
      const entries = Object.values(await liveEntries()).filter((e) => e.kind === kind);
      const agents = await managedAgents();
      const templates = await allTemplates();
      const out: ManagedPartSummary[] = [];
      for (const entry of entries) {
        const usedBy = agents
          .filter(({ agent }) => listOf(agent.managed!, kind).includes(entry.id))
          .map(({ projectPath, projectName, agent }) => ({ projectPath, projectName, agentId: agent.id, agentName: agent.name, color: agent.color, running: deps.isRunning(agent.id) }));
        out.push(await summarize(entry, usedBy, templates));
      }
      return out.sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name));
    },

    async getPart(id: string): Promise<ManagedPart> {
      const entry = await entryOf(id);
      return { ...(await summarize(entry)), content: await contentOf(entry) };
    },

    async createPart(input: { name: string; description?: string; content: ManagedPartContent; actor?: string; source?: Extract<AssetSource, { kind: 'import' | 'plugin' }> }, beforeCommit?: () => Promise<void>): Promise<ManagedPartSummary> {
      const kind = input.content.kind;
      const name = input.name.trim();
      if (!name) throw new ManagedError('invalid', 'Give it a name.');
      refuseEnvValues(input.content);
      const taken = (await liveEntries());
      if (Object.values(taken).some((e) => e.kind === kind && !isRetiredBuiltin(e) && e.name.toLowerCase() === name.toLowerCase())) {
        throw new ManagedError('name_taken', `${name} already exists. Use it, or pick another name.`);
      }
      let entry: CatalogEntry;
      try {
        entry = await catalog.createAsset({ kind, name, payload: contentToPayload(input.content), ...(input.source && { source: input.source }) }, beforeCommit);
      } catch (err) {
        // telemetry-exempt: rethrown as a ManagedError with a code the caller shows.
        mapCatalogError(err);
      }
      const partial = (metadata: ManagedPartCreationReceipt['metadata'], unfinishedStage: ManagedPartCreationReceipt['unfinishedStage']) => {
        appLog('core:managed', 'warn', 'Library part creation is incomplete after catalog commit', { meta: { partId: entry.id, stage: unfinishedStage } });
        return new ManagedPartCreationError({ partId: entry.id, revision: entry.headRevision, catalog: 'committed', metadata, unfinishedStage,
          recovery: 'Read this existing part by id after repairing local storage, then finish its metadata with an update. No rollback was attempted; never create a second copy automatically.' });
      };
      try {
        await state.update((s) => {
          const actor = actorOf(input.actor);
          s.parts[entry.id] = { ...(input.description?.trim() && { description: input.description.trim() }), ...(actor && { updatedBy: actor }) };
        });
      } catch {
        await auditManaged('managed.part.created', entry.id);
        changed();
        throw partial('not_saved', 'metadata');
      }
      await auditManaged('managed.part.created', entry.id);
      changed();
      try { return await summarize(entry); } catch {
        throw partial('saved', 'readback');
      }
    },

    /**
     * Edit a custom part for everyone who uses it. Built-ins are read-only.
     * A rename or a description edit doesn't change the revision, so the
     * editor and the MCP tool also send the name and description they read
     * (`expectedName`, `expectedDescription`): a part renamed or redescribed
     * since is refused as stale like a content change (D92).
     */
    async updatePart(input: {
      id: string; expectedRevision: number; expectedName?: string; expectedDescription?: string;
      name?: string; description?: string; content?: ManagedPartContent; actor?: string;
    }): Promise<ManagedPartSummary> {
      let entry = await entryOf(input.id);
      if (entry.source.kind === 'builtin') throw new ManagedError('builtin_read_only', 'Built-in parts can\'t be edited. Make your copy instead.');
      if (entry.headRevision !== input.expectedRevision) throw new ManagedError('stale', 'It changed since you opened it.');
      const currentDescription = (await state.read()).parts[entry.id]?.description ?? '';
      if ((input.expectedName !== undefined && input.expectedName.trim() !== entry.name)
        || (input.expectedDescription !== undefined && input.expectedDescription.trim() !== currentDescription)) {
        throw new ManagedError('stale', 'It changed since you opened it.');
      }
      refuseEnvValues(input.content);
      // A taken name is refused before anything is saved, so a refused rename changes nothing (#3099).
      const newName = input.name !== undefined && input.name.trim() && input.name.trim() !== entry.name ? input.name.trim() : undefined;
      if (newName && Object.values(await liveEntries()).some((e) => e.kind === entry.kind && e.id !== entry.id && !isRetiredBuiltin(e) && e.name.toLowerCase() === newName.toLowerCase())) {
        throw new ManagedError('name_taken', `${newName} already exists.`);
      }
      // The catalog's own name rules (length, control characters, secrets), checked here for the same reason.
      if (newName && nameIssues(newName).length > 0) throw new ManagedError('invalid', 'Check the name.');
      try {
        if (input.content) {
          if (input.content.kind !== entry.kind) throw new ManagedError('invalid');
          let payload = contentToPayload(input.content);
          // Keep catalog-only MCP fields the builder doesn't edit (auth, upstream).
          if (input.content.kind === 'mcp') {
            const current = await catalog.readRevision(entry.id, entry.headRevision) as McpAssetPayload;
            payload = { ...(current.auth && { auth: current.auth }), ...(current.upstream && { upstream: current.upstream }), ...payload } as McpAssetPayload;
          }
          entry = await catalog.saveRevision({ assetId: entry.id, expectedRevision: input.expectedRevision, payload });
        }
        if (newName) entry = await catalog.renameAsset({ assetId: entry.id, expectedName: entry.name, name: newName });
      } catch (err) {
        // telemetry-exempt: rethrown as a ManagedError with a code the caller shows.
        mapCatalogError(err);
      }
      await state.update((s) => {
        const meta = { ...(s.parts[entry.id] ?? {}) };
        if (input.description !== undefined) {
          if (input.description.trim()) meta.description = input.description.trim();
          else delete meta.description;
        }
        const actor = actorOf(input.actor);
        if (actor) meta.updatedBy = actor;
        else delete meta.updatedBy;
        s.parts[entry.id] = meta;
      });
      await auditManaged('managed.part.updated', entry.id);
      changed();
      return summarize(entry);
    },

    /**
     * A custom copy in the library. With an agent, that agent switches to the
     * copy and the copy is named after it. Forks don't follow their source.
     */
    async forkPart(input: { id: string; agent?: { projectPath: string; agentId: string }; name?: string; actor?: string }): Promise<ManagedPartSummary> {
      if (input.id === CLUBHOUSE_MCP_PART_ID) throw new ManagedError('invalid', CLUBHOUSE_PART_ALWAYS_ON);
      const entry = await entryOf(input.id);
      const content = await contentOf(entry);
      const kind = entry.kind as ManagedPartKind;
      let agent: DurableAgentConfig | null = null;
      if (input.agent) {
        agent = await deps.getAgent(input.agent.projectPath, input.agent.agentId);
        if (!agent) throw new ManagedError('not_found');
        if (!agent.managed) throw new ManagedError('not_managed');
      }
      const wanted = input.name?.trim() || (agent ? `${entry.name}, ${agent.name}` : `${entry.name} copy`);
      const name = await uniqueName(kind, wanted);
      if (content.kind === 'skill' && agent) {
        // Two skills with one folder name can't both be delivered; the copy takes the folder.
      }
      let copy: CatalogEntry;
      try {
        copy = await catalog.createAsset({ kind, name, payload: contentToPayload(content) });
      } catch (err) {
        // telemetry-exempt: rethrown as a ManagedError with a code the caller shows.
        mapCatalogError(err);
      }
      const s0 = await state.read();
      const description = entry.source.kind === 'builtin' ? BUILTINS.get(entry.id)?.description : s0.parts[entry.id]?.description;
      await state.update((s) => {
        const actor = actorOf(input.actor);
        s.parts[copy.id] = { ...(description && { description }), forkedFrom: entry.id, ...(actor && { updatedBy: actor }) };
      });
      await auditManaged('managed.part.created', copy.id);
      if (agent && input.agent) {
        await writeAgentSetup(input.agent.projectPath, input.agent.agentId, replaceIn(agent.managed!, entry.id, copy.id), { before: agent, actor: input.actor });
      }
      changed();
      return summarize(copy);
    },

    /** Put an agent back on the part a fork came from. The fork stays in the library. */
    async backToShared(input: { projectPath: string; agentId: string; id: string }): Promise<void> {
      const agent = await deps.getAgent(input.projectPath, input.agentId);
      if (!agent?.managed) throw new ManagedError('not_managed');
      const s = await state.read();
      const origin = s.parts[input.id]?.forkedFrom;
      const live = await liveEntries();
      if (!origin || !live[origin]) throw new ManagedError('not_found', 'The part it was copied from is gone.');
      await writeAgentSetup(input.projectPath, input.agentId, replaceIn(agent.managed, input.id, origin), { before: agent });
      changed();
    },

    async consumers(id: string): Promise<ManagedPartConsumer[]> {
      return consumersOf(id);
    },

    /**
     * Delete a part. In use, `copy` gives each agent its own copy and `remove`
     * takes it out of them. Templates drop it either way.
     */
    async deletePart(input: { id: string; expectedRevision: number; mode: 'copy' | 'remove' }): Promise<void> {
      const entry = await entryOf(input.id);
      if (entry.source.kind === 'builtin') throw new ManagedError('builtin_read_only');
      if (entry.headRevision !== input.expectedRevision) throw new ManagedError('stale');
      const users = (await managedAgents()).filter(({ agent }) => KINDS.some((k) => listOf(agent.managed!, k).includes(entry.id)));
      // Delete first: the catalog checks the revision, so a part saved meanwhile is refused with nothing changed.
      const content = await contentOf(entry);
      const s0 = await state.read();
      const description = s0.parts[entry.id]?.description;
      try {
        await catalog.deleteAsset({ assetId: entry.id, expectedRevision: input.expectedRevision });
      } catch (err) {
        // telemetry-exempt: rethrown as a ManagedError with a code the caller shows.
        mapCatalogError(err);
      }
      for (const { projectPath, agent } of users) {
        const setup = agent.managed!;
        if (input.mode === 'copy') {
          const name = await uniqueName(entry.kind as ManagedPartKind, `${entry.name}, ${agent.name}`);
          const copy = await catalog.createAsset({ kind: entry.kind, name, payload: contentToPayload(content) });
          await state.update((s) => { s.parts[copy.id] = { ...(description && { description }) }; });
          await auditManaged('managed.part.created', copy.id);
          await writeAgentSetup(projectPath, agent.id, replaceIn(setup, entry.id, copy.id), { before: agent });
        } else {
          await writeAgentSetup(projectPath, agent.id, replaceIn(setup, entry.id, null), { before: agent });
        }
      }
      await state.update((s) => {
        for (const t of Object.values(s.templates)) {
          t.setup = { blocks: t.setup.blocks.filter((x) => x !== entry.id), skills: t.setup.skills.filter((x) => x !== entry.id), mcps: t.setup.mcps.filter((x) => x !== entry.id) };
        }
        delete s.parts[entry.id];
      });
      await auditManaged('managed.part.deleted', entry.id);
      changed();
    },

    // ── Setups ─────────────────────────────────────────────────────────

    async getSetup(projectPath: string, agentId: string): Promise<ManagedAgentSetup | null> {
      const agent = await deps.getAgent(projectPath, agentId);
      if (!agent) throw new ManagedError('not_found');
      return agent.managed ? withClubhouseSetup(agent.managed) : null;
    },

    /**
     * The checks a setup must pass to be saved, without saving it: unknown or
     * deleted part ids are refused, and two skills can't share a folder.
     * Returns the setup as it would be saved (duplicates dropped).
     * `planned.skillFolders` are skills about to be made for it (a switch to
     * managed), checked for a folder clash before any is made.
     */
    async checkSetup(setup: Omit<ManagedAgentSetup, 'version'>, planned: { skillFolders?: string[] } = {}): Promise<ManagedAgentSetup> {
      const live = await liveEntries();
      const clean = (ids: string[], kind: ManagedPartKind) => {
        const out: string[] = [];
        for (const id of ids) {
          // Always in the setup, installed by Clubhouse: not refused before the startup install has run.
          if (id === CLUBHOUSE_MCP_PART_ID && kind === 'mcp') {
            if (!out.includes(id)) out.push(id);
            continue;
          }
          const entry = live[id];
          if (!entry || entry.kind !== kind) throw new ManagedError('not_found', `A ${kind} in this setup no longer exists.`);
          if (!out.includes(id)) out.push(id);
        }
        return out;
      };
      const next: ManagedAgentSetup = {
        version: 1,
        blocks: clean(setup.blocks, 'block'),
        skills: clean(setup.skills, 'skill'),
        mcps: clean(withClubhousePart(setup.mcps), 'mcp'),
        ...(setup.templateId && { templateId: setup.templateId }),
      };
      // Two skills that deliver to one folder can't both reach the agent, and Clubhouse never picks one.
      const named = await skillFolders(next.skills, live);
      for (const name of planned.skillFolders ?? []) named.push({ name, skillName: name });
      refuseSkillFolderClash(named);
      const serverKeys = new Set<string>();
      for (const id of next.mcps) {
        if (id === CLUBHOUSE_MCP_PART_ID) continue;
        const content = await contentOf(live[id]);
        if (content.kind !== 'mcp') continue;
        if (serverKeys.has(content.serverKey)) throw new ManagedError('invalid', 'Two MCP parts in this setup use the same server key. Choose one; Clubhouse will not overwrite a server by precedence.');
        serverKeys.add(content.serverKey);
      }
      return next;
    },

    /**
     * Save what an agent is built from, after checkSetup's checks. The Clubhouse
     * MCP part is added when it's missing. `helperChanges` is start_helper's
     * record of what it changed from the template; who saved it comes from
     * `actor` or the surface the call runs under (D90). Bookkeeping fields the
     * caller passes inside `setup` are ignored.
     */
    async saveSetup(
      projectPath: string,
      agentId: string,
      setup: Omit<ManagedAgentSetup, 'version'>,
      opts: { helperChanges?: ManagedHelperChanges; actor?: string; precondition?: import('../agent-config').ManagedSetupCommitPrecondition } = {},
    ): Promise<ManagedAgentSetup> {
      const agent = await deps.getAgent(projectPath, agentId);
      if (!agent) throw new ManagedError('not_found');
      if (!agent.worktreePath) throw new ManagedError('invalid', `${agent.name} works in the project folder. Managed agents need their own folder.`);
      const next = await api.checkSetup(setup);
      const written = await writeAgentSetup(projectPath, agentId, next, { before: agent, ...opts });
      changed();
      return written;
    },

    /**
     * Clear an agent's setup. It keeps the last files Clubhouse wrote, except
     * the settings Clubhouse added for itself, which onUnmanaged removes.
     * Switch to plain (`plain.ts`, D98) calls this, then brings back the
     * earlier files the person chose.
     */
    async unmanage(projectPath: string, agentId: string): Promise<void> {
      const agent = await deps.getAgent(projectPath, agentId);
      const wasManaged = !!agent?.managed;
      await deps.setManagedSetup(projectPath, agentId, null);
      if (agent && wasManaged) await deps.onUnmanaged?.(projectPath, agent);
      changed();
    },

    // ── Templates ──────────────────────────────────────────────────────

    async listTemplates(): Promise<Array<ManagedTemplate & { usedBy: number }>> {
      const templates = await allTemplates();
      const agents = await managedAgents();
      return templates.map((t) => ({ ...t, usedBy: agents.filter(({ agent }) => agent.managed?.templateId === t.id).length }));
    },

    async getTemplate(id: string): Promise<ManagedTemplate> {
      const t = (await allTemplates()).find((x) => x.id === id);
      if (!t) throw new ManagedError('not_found');
      return t;
    },

    async saveTemplate(input: Omit<ManagedTemplate, 'builtin' | 'updatedAt' | 'updatedBy' | 'id'> & { id?: string; actor?: string }): Promise<ManagedTemplate> {
      if (input.id && BUILTIN_TEMPLATES.has(input.id)) throw new ManagedError('builtin_read_only', 'Built-in templates can\'t be edited. Make your copy instead.');
      const name = input.name.trim();
      if (!name) throw new ManagedError('invalid', 'Give it a name.');
      const live = await liveEntries();
      // Parts that exist, each once (as checkSetup keeps them), so a repeated skill is no clash with itself.
      const keep = (ids: string[]) => [...new Set(ids)].filter((id) => live[id]);
      refuseSkillFolderClash(await skillFolders(keep(input.setup.skills), live));
      const actor = actorOf(input.actor);
      const template = await state.update((s) => {
        const id = input.id ?? `template-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
        if (input.id && !s.templates[input.id]) throw new ManagedError('not_found');
        // A retired built-in's name (D71) is free: nothing lists it any more.
        const clash = [...BUILTIN_TEMPLATES.values(), ...Object.values(s.templates)].some((t) => isListed(t) && t.id !== id && t.name.toLowerCase() === name.toLowerCase());
        if (clash) throw new ManagedError('name_taken', `A template called ${name} already exists.`);
        const t: ManagedTemplate = {
          id, name, description: input.description?.trim() ?? '', builtin: false,
          setup: { blocks: keep(input.setup.blocks), skills: keep(input.setup.skills), mcps: withClubhousePart(keep(input.setup.mcps)) },
          settings: templateSettingsToKeep(input.settings ?? {}),
          updatedAt: new Date().toISOString(),
          ...(actor && { updatedBy: actor }),
        };
        s.templates[id] = t;
        return t;
      });
      await auditManaged('managed.template.saved', template.id);
      changed();
      return template;
    },

    async deleteTemplate(id: string): Promise<void> {
      if (BUILTIN_TEMPLATES.has(id)) throw new ManagedError('builtin_read_only');
      await state.update((s) => {
        if (!s.templates[id]) throw new ManagedError('not_found');
        delete s.templates[id];
        if (s.defaultHelperTemplateId === id) delete s.defaultHelperTemplateId;
      });
      await auditManaged('managed.template.deleted', id);
      changed();
    },

    /** The agents made from a template, with project and status, for a delete's preview. */
    async templateConsumers(id: string): Promise<ManagedPartConsumer[]> {
      return (await managedAgents())
        .filter(({ agent }) => agent.managed?.templateId === id)
        .map(({ projectPath, projectName, agent }) => ({
          projectPath, projectName, agentId: agent.id, agentName: agent.name, color: agent.color, running: deps.isRunning(agent.id),
        }));
    },

    /** Save an agent's whole setup and settings as a new template. */
    async templateFromAgent(projectPath: string, agentId: string, name: string, description = ''): Promise<ManagedTemplate> {
      const agent = await deps.getAgent(projectPath, agentId);
      if (!agent?.managed) throw new ManagedError('not_managed');
      return api.saveTemplate({
        name, description,
        setup: { blocks: agent.managed.blocks, skills: agent.managed.skills, mcps: agent.managed.mcps },
        settings: settingsOf(agent, projectPath),
      });
    },

    /** The changes an edit makes to a template, and the agents made from it. */
    async previewTemplatePush(id: string, edited: Pick<ManagedTemplate, 'setup' | 'settings'>): Promise<{ changes: ManagedTemplateChange[]; targets: ManagedTemplatePushTarget[] }> {
      // Removing the Clubhouse part is no change: it stays in every template.
      // Refused whole when a setting isn't one the setting takes, before anything is compared or written.
      const next = { ...withClubhousePartIn(edited), settings: checkTemplateSettings(edited.settings) };
      const current = await api.getTemplate(id);
      const live = await liveEntries();
      const label = await templateLabeler();
      const changes = withEffortFollowingModel(diffTemplates(current, next, (pid) => live[pid]?.name ?? pid, label), next.settings, label);
      const agents = (await managedAgents()).filter(({ agent }) => agent.managed?.templateId === id);
      const targets = agents.map(({ projectPath, agent }) => {
        const appliesHere = (c: ManagedTemplateChange) => pushApplies(c, agent, changes, next.settings, label, projectPath);
        const applicable = changes.filter(appliesHere);
        const skipped = changes.filter((c) => !appliesHere(c));
        return {
          projectPath, agentId: agent.id, agentName: agent.name, color: agent.color, running: deps.isRunning(agent.id),
          applicable: applicable.length, total: changes.length,
          ...(skipped.length > 0 && { note: skipped.map((c) => describeSkipped(c, agent, changes, next.settings)).join(', ') }),
        };
      });
      return { changes, targets };
    },

    /**
     * Apply a template edit's changes to the agents named. Settings changes are
     * returned for the caller to apply. Each agent the push reached is in the
     * result, with `changed` false when none of the changes applied to it.
     * Agents not made from the template are left out.
     */
    async pushTemplate(id: string, edited: Pick<ManagedTemplate, 'setup' | 'settings'>, agents: Array<{ projectPath: string; agentId: string }>, opts?: { precondition: (target: { projectPath: string; agentId: string }, settings: ManagedTemplateSettings) => import('../agent-config').ManagedSetupCommitPrecondition; checkTemplateWrite?: () => void }): Promise<TemplatePushResult[]> {
      // Checked before any agent is written, so a bad setting never leaves agents half-updated.
      const next = { ...withClubhousePartIn(edited), settings: checkTemplateSettings(edited.settings) };
      const current = await api.getTemplate(id);
      const live = await liveEntries();
      // Every part the edit names must still exist, as its kind.
      for (const kind of KINDS) {
        for (const pid of listOf({ version: 1, ...next.setup }, kind)) {
          if (live[pid]?.kind !== kind) throw new ManagedError('not_found', 'A part in this template no longer exists. Reload and try again.');
        }
      }
      const label = await templateLabeler();
      const changes = withEffortFollowingModel(diffTemplates(current, next, (pid) => live[pid]?.name ?? pid, label), next.settings, label);
      const settingsOut: TemplatePushResult[] = [];
      for (const target of agents) {
        const agent = await deps.getAgent(target.projectPath, target.agentId);
        if (!agent?.managed || agent.managed.templateId !== id) continue;
        // Nothing applies (it already has every change): skipped, and not saved again.
        if (!changes.some((c) => pushApplies(c, agent, changes, next.settings, label, target.projectPath))) {
          settingsOut.push({ ...target, settings: {}, changed: false });
          continue;
        }
        let setup: ManagedAgentSetup = { ...agent.managed, blocks: [...agent.managed.blocks], skills: [...agent.managed.skills], mcps: [...agent.managed.mcps] };
        const settings: ManagedTemplateSettings = {};
        for (const change of changes) {
          if (change.kind === 'add') {
            const list = listOf(setup, change.part);
            if (!list.includes(change.id)) list.push(change.id);
          } else if (change.kind === 'remove') {
            setup = replaceIn(setup, change.id, null);
          } else if (change.kind === 'setting' && change.key !== 'effort') {
            mergeSetting(settings, next.settings, change.key, current.settings);
          }
        }
        // The effort goes only with the model it is for (D81).
        const effort = effortOutcome(agent, changes, next.settings);
        if (effort.send !== undefined) settings.effort = effort.send;
        try {
          // Through saveSetup, so each agent's result is checked (skill folders, missing parts).
          const precondition = opts?.precondition(target, settings);
          await api.saveSetup(target.projectPath, target.agentId, setup, precondition ? { precondition } : {});
          settingsOut.push({ ...target, settings, changed: true });
        } catch (err) {
          // telemetry-exempt: reported to the caller per agent, and shown in the push dialog.
          settingsOut.push({ ...target, settings: {}, changed: false, failed: err instanceof Error ? err.message : String(err) });
        }
      }
      if (!BUILTIN_TEMPLATES.has(id)) {
        const actor = actorOf();
        await state.update((s) => {
          opts?.checkTemplateWrite?.();
          const t = s.templates[id];
          if (!t) return;
          const { updatedBy: _was, ...rest } = t;
          s.templates[id] = { ...rest, setup: { ...next.setup }, settings: templateSettingsToKeep(next.settings), updatedAt: new Date().toISOString(), ...(actor && { updatedBy: actor }) };
        });
      }
      // Each agent's own setup change is recorded where agent configs are written.
      await auditManaged('managed.template.pushed', id);
      changed();
      return settingsOut;
    },

    async defaultHelperTemplateId(): Promise<string> {
      const s = await state.read();
      const id = s.defaultHelperTemplateId;
      if (id && ((BUILTIN_TEMPLATES.has(id) && isListed(BUILTIN_TEMPLATES.get(id)!)) || s.templates[id])) return id;
      return DEFAULT_HELPER_TEMPLATE_ID;
    },

    async setDefaultHelperTemplateId(id: string): Promise<void> {
      await api.getTemplate(id);
      const before = await api.defaultHelperTemplateId();
      await state.update((s) => {
        if (id === DEFAULT_HELPER_TEMPLATE_ID) delete s.defaultHelperTemplateId;
        else s.defaultHelperTemplateId = id;
      });
      await auditManagedSetting('defaultHelperTemplate', before, id);
      changed();
    },

    /** Whether orchestrators may name a template, or add and remove parts, for a helper (#2899). Off by default. */
    async helperTemplateChoice(): Promise<boolean> {
      return (await state.read()).helperTemplateChoice === true;
    },

    async setHelperTemplateChoice(on: boolean): Promise<void> {
      const before = await state.update((s) => {
        const was = s.helperTemplateChoice === true;
        if (on) s.helperTemplateChoice = true;
        else delete s.helperTemplateChoice;
        return was;
      });
      await auditManagedSetting('helperTemplateChoice', before, on);
      changed();
    },

    /** The setup a template gives a new agent: only parts that still exist. */
    async setupFromTemplate(id: string): Promise<{ setup: ManagedAgentSetup; settings: ManagedTemplateSettings }> {
      const t = await api.getTemplate(id);
      const live = await liveEntries();
      const keep = (ids: string[]) => ids.filter((x) => live[x]);
      return {
        setup: { version: 1, blocks: keep(t.setup.blocks), skills: keep(t.setup.skills), mcps: withClubhousePart(keep(t.setup.mcps)), templateId: t.id },
        settings: { ...t.settings },
      };
    },

    /** Read a part's head content, for delivery. */
    async headContent(id: string): Promise<{ entry: CatalogEntry; content: ManagedPartContent; droppedEnvValues: string[]; fromRetiredBuiltin?: true } | null> {
      const live = await liveEntries();
      const entry = live[id];
      if (!entry) return null;
      const retiredCopy = entry.source.kind !== 'builtin' && !!(await state.read()).parts[id]?.fromRetiredBuiltin;
      return { entry, ...(await readHead(entry)), ...(retiredCopy && { fromRetiredBuiltin: true as const }) };
    },

    async liveEntries(): Promise<Record<string, CatalogEntry>> {
      return liveEntries();
    },
  };
  return api;
}

export type ManagedAgentsService = ReturnType<typeof createManagedAgentsService>;

/** One agent a template push reached. */
export interface TemplatePushResult {
  projectPath: string;
  agentId: string;
  /** The settings changes for the caller to apply. */
  settings: ManagedTemplateSettings;
  /** Whether the push changed this agent. False when nothing applied, or it failed. */
  changed: boolean;
  failed?: string;
}

/** A fixed row or a Helper control row: well-formed, but never kept in a template. */
function isDroppedQuietly(g: unknown): boolean {
  const e = g as { action?: GrantAction; target?: TemplateGrant['target'] };
  return !!e?.action && !!e.target && (isFixedGrant(e as TemplateGrant) || isHelperControlRow(e as TemplateGrant));
}

/** What an agent carries over its default permissions (#2971); none when they can't be read. */
function grantsOf(agentId: string): GrantChange[] {
  try {
    return carriedAgentGrants(agentId);
  } catch {
    // telemetry-exempt: a template saved without them gets the defaults, which the person sees on the template.
    return [];
  }
}

/** An agent's settings as a template carries them. `projectPath` turns a pre-#2761 Free Agent Mode into its level. */
export function settingsOf(agent: DurableAgentConfig, projectPath?: string, grants: readonly GrantChange[] = grantsOf(agent.id)): ManagedTemplateSettings {
  return {
    ...(grants.length > 0 && { grants: grants.map((g) => ({ action: g.action, target: g.target, mode: g.mode })) }),
    ...(agent.orchestrator && { orchestrator: agent.orchestrator }),
    ...(agent.model && { model: agent.model }),
    ...(agent.effort && { effort: agent.effort }),
    ...((agent.access !== undefined || agent.freeAgentMode !== undefined) && { access: agentAccess(agent, projectPath) }),
    ...(agent.orchestration && Object.keys(agent.orchestration).length > 0 && { orchestration: { ...agent.orchestration } }),
    ...(agent.idleSleep !== undefined && { idleSleep: agent.idleSleep }),
    ...(agent.helperTemplateId && { helperTemplateId: agent.helperTemplateId }),
  };
}

/**
 * The settings a template keeps: the ones it sets, checked. A `null` (apply
 * only) or a value that isn't one of the setting's is left out, so a saved
 * template never carries one.
 */
export function templateSettingsToKeep(settings: ManagedTemplateSettings): ManagedTemplateSettings {
  const { effort, idleSleep, helperTemplateId, grants, ...rest } = settings;
  const out: ManagedTemplateSettings = withAccess({ ...rest }, getPermissionMode());
  const kept = normalizeTemplateGrants(grants);
  if (kept?.length) out.grants = kept;
  if (isEffortValue(effort)) out.effort = effort;
  const idle = normalizeIdleSleep(idleSleep);
  if (idle !== 'inherit') out.idleSleep = idle;
  if (typeof helperTemplateId === 'string' && helperTemplateId && helperTemplateId.length <= 128) out.helperTemplateId = helperTemplateId;
  return out;
}

/** A setting's value as the push dialog shows it. Helper templates by name. */
type SettingLabeler = (key: string, value: unknown) => string;

function settingLabel(value: unknown): string {
  if (value === undefined || value === null) return 'unset';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function labelerFor(templateName: (id: string) => string | undefined): SettingLabeler {
  const unset: Record<string, string> = { effort: 'CLI default', idleSleep: 'app default', helperTemplateId: 'app default' };
  return (key, value) => {
    if ((value === undefined || value === null) && unset[key]) return unset[key];
    // A template without a level gives agents the Default access (#2998), as creation does.
    if (key === 'access' && (value === undefined || value === null)) return `${accessLabel(getDefaultAccess())} (Default access)`;
    if (key === 'helperTemplateId' && typeof value === 'string') return templateName(value) ?? value;
    if (key === 'idleSleep' && typeof value === 'number') return `${value} min`;
    if (key === 'access' && isAccessLevel(value)) return accessLabel(value);
    if (key.startsWith('grants.')) return value === 'allow' ? 'Allow' : value === 'ask' ? 'Ask first' : value === 'off' ? 'Off' : 'default';
    return settingLabel(value);
  };
}

function flattenSettings(settings: ManagedTemplateSettings): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (settings.orchestrator !== undefined) out.orchestrator = settings.orchestrator;
  if (settings.model !== undefined) out.model = settings.model;
  if (settings.effort !== undefined && settings.effort !== null) out.effort = settings.effort;
  const access = withAccess(settings, getPermissionMode()).access;
  if (access !== undefined) out.access = access;
  for (const [k, v] of Object.entries(settings.orchestration ?? {})) out[`orchestration.${k}`] = v;
  if (settings.idleSleep !== undefined && settings.idleSleep !== null) out.idleSleep = settings.idleSleep;
  if (settings.helperTemplateId) out.helperTemplateId = settings.helperTemplateId;
  // One key per permission, so the push dialog lists each one that changes (#2971).
  for (const g of settings.grants ?? []) if (g.mode !== null) out[`grants.${grantKey(g)}`] = g.mode;
  return out;
}

/** "Clubhouse permission: Send messages and files (Connected agents)". */
function grantChangeLabel(g: Pick<TemplateGrant, 'action' | 'target'>): string {
  return `Clubhouse permission: ${GRANT_ACTION_LABELS[g.action] ?? g.action} (${grantTargetLabel(g.target)})`;
}

function grantByKey(settings: ManagedTemplateSettings | undefined, key: string): TemplateGrant | undefined {
  return settings?.grants?.find((g) => `grants.${grantKey(g)}` === key);
}

/**
 * Add one changed setting to what gets applied. A setting the template no
 * longer sets goes back to the default: null for orchestration fields, the
 * effort, auto-sleep and helper template, the CLI default model, the Default access (#2998). The CLI is never unset.
 */
function mergeSetting(out: ManagedTemplateSettings, from: ManagedTemplateSettings, key: string, before?: ManagedTemplateSettings): void {
  if (key.startsWith('grants.')) {
    // One the template no longer sets is taken away (null); the agent goes back to its default for it.
    const set = grantByKey(from, key);
    const gone = set ? undefined : grantByKey(before, key);
    const entry = set ?? (gone && { ...gone, mode: null });
    if (entry) out.grants = [...(out.grants ?? []), { action: entry.action, target: entry.target, mode: entry.mode }];
    return;
  }
  if (key.startsWith('orchestration.')) {
    const k = key.slice('orchestration.'.length);
    const value = (from.orchestration as Record<string, unknown> | undefined)?.[k];
    out.orchestration = { ...(out.orchestration ?? {}), [k]: value === undefined ? null : value } as ManagedTemplateSettings['orchestration'];
    return;
  }
  if (key === 'model') out.model = from.model ?? 'default';
  else if (key === 'effort') out.effort = from.effort ?? null;
  else if (key === 'access') out.access = withAccess(from, getPermissionMode()).access ?? getDefaultAccess();
  else if (key === 'idleSleep') out.idleSleep = from.idleSleep ?? null;
  else if (key === 'helperTemplateId') out.helperTemplateId = from.helperTemplateId ?? null;
  else if (key === 'orchestrator' && from.orchestrator) out.orchestrator = from.orchestrator;
}

export function diffTemplates(
  current: Pick<ManagedTemplate, 'setup' | 'settings'>,
  next: Pick<ManagedTemplate, 'setup' | 'settings'>,
  nameOf: (id: string) => string,
  label: SettingLabeler = (_key, value) => settingLabel(value),
): ManagedTemplateChange[] {
  const changes: ManagedTemplateChange[] = [];
  for (const kind of KINDS) {
    const key = kind === 'block' ? 'blocks' : kind === 'skill' ? 'skills' : 'mcps';
    const before = current.setup[key];
    const after = next.setup[key];
    for (const id of after) if (!before.includes(id)) changes.push({ kind: 'add', part: kind, id, name: nameOf(id) });
    for (const id of before) if (!after.includes(id)) changes.push({ kind: 'remove', part: kind, id, name: nameOf(id) });
  }
  const shared = next.setup.blocks.filter((id) => current.setup.blocks.includes(id));
  const sharedBefore = current.setup.blocks.filter((id) => next.setup.blocks.includes(id));
  if (shared.join('\n') !== sharedBefore.join('\n')) changes.push({ kind: 'order' });
  const a = flattenSettings(current.settings);
  const b = flattenSettings(next.settings);
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (JSON.stringify(a[key]) === JSON.stringify(b[key])) continue;
    const grant = key.startsWith('grants.') ? grantByKey(next.settings, key) ?? grantByKey(current.settings, key) : undefined;
    changes.push({ kind: 'setting', key, from: label(key, a[key]), to: label(key, b[key]), ...(grant && { label: grantChangeLabel(grant) }) });
  }
  return changes;
}

function applies(change: ManagedTemplateChange, agent: DurableAgentConfig, label: SettingLabeler = (_key, value) => settingLabel(value), projectPath?: string): boolean {
  const setup = agent.managed!;
  if (change.kind === 'add') return !listOf(setup, change.part).includes(change.id);
  if (change.kind === 'remove') return listOf(setup, change.part).includes(change.id);
  if (change.kind === 'order') return false;
  // Back to no level: the agent goes to the Default access, so one already there doesn't change.
  if (change.key === 'access' && change.to === label('access', undefined)) return agentAccess(agent, projectPath) !== getDefaultAccess();
  // A permission is compared with what the agent's template layer sets, not with the person's own change over it (#2971).
  const flat = change.key.startsWith('grants.')
    ? flattenSettings({ grants: templateGrantsOf(agent.id) })
    : flattenSettings(settingsOf(agent, projectPath));
  return label(change.key, flat[change.key]) !== change.to;
}

function templateGrantsOf(agentId: string): GrantChange[] {
  try {
    return templateLayerGrants(agentId);
  } catch {
    // telemetry-exempt: counted as not set, so the push writes it.
    return [];
  }
}

/**
 * A template's settings from a push or preview, checked: a value a setting
 * doesn't take refuses the whole call. `null` (back to the default) is
 * dropped, as a saved template never keeps one.
 */
export function checkTemplateSettings(raw: unknown): ManagedTemplateSettings {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ManagedError('invalid', 'settings must be an object.');
  const s = raw as Record<string, unknown>;
  const bad = (what: string): never => { throw new ManagedError('invalid', `The template's ${what}. Nothing was changed.`); };
  if (s.orchestrator !== undefined && (typeof s.orchestrator !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(s.orchestrator))) bad('CLI isn\'t a CLI id');
  if (s.model !== undefined && (typeof s.model !== 'string' || !s.model || s.model.length > 200)) bad('model isn\'t a model id');
  if (s.effort !== undefined && s.effort !== null && !isEffortValue(s.effort)) bad('effort isn\'t an effort level such as low, medium or high');
  if (s.freeAgentMode !== undefined && typeof s.freeAgentMode !== 'boolean') bad('freeAgentMode must be true or false');
  if (s.access !== undefined && !isAccessLevel(s.access)) bad(`access isn't one of ${ACCESS_LEVELS.join(', ')}`);
  if (s.idleSleep !== undefined && s.idleSleep !== null && s.idleSleep !== 'never'
    && !(typeof s.idleSleep === 'number' && Number.isInteger(s.idleSleep) && s.idleSleep > 0)) bad('auto-sleep must be "never" or whole minutes');
  if (s.helperTemplateId !== undefined && s.helperTemplateId !== null
    && (typeof s.helperTemplateId !== 'string' || s.helperTemplateId.length > 128)) bad('helper template isn\'t a template id');
  if (s.grants !== undefined) {
    // Fixed rows and Helper control's rows are dropped quietly when kept; anything malformed refuses the call.
    const wellFormed = Array.isArray(s.grants)
      && (s.grants as unknown[]).every((g) => normalizeTemplateGrants([g])?.length === 1 || isDroppedQuietly(g));
    if (!wellFormed) bad('Clubhouse permissions aren\'t a list of an action, a target, and off, ask or allow');
  }
  if (s.orchestration !== undefined) {
    try {
      validateOrchestrationPatch(s.orchestration);
    } catch (err) {
      // telemetry-exempt: refused to the caller with the reason.
      bad(`orchestration is invalid (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return templateSettingsToKeep(s as ManagedTemplateSettings);
}

const modelOf = (model: string | undefined): string => (model && model !== 'default' ? model : 'default');

/**
 * What a push does to an agent's effort. An effort is for one model: the
 * template's effort goes only to an agent that will run the template's model
 * (on its CLI, when the template names one), so an agent that chose its own
 * model keeps its effort. A pushed model or CLI change that changes the agent's
 * model clears its effort (updateDurableConfig does), so the template's effort,
 * when it has one for that model, is sent with it.
 */
function effortOutcome(agent: DurableAgentConfig, changes: ManagedTemplateChange[], next: ManagedTemplateSettings): { send?: string | null; skipped?: string; resets: boolean } {
  const has = (key: string) => changes.some((c) => c.kind === 'setting' && c.key === key && !c.followsModel);
  const cliAfter = has('orchestrator') && next.orchestrator ? next.orchestrator : agent.orchestrator;
  const cliChanges = (cliAfter ?? '') !== (agent.orchestrator ?? '');
  // A new CLI without a model clears the agent's model too.
  const modelAfter = has('model') ? modelOf(next.model) : cliChanges ? 'default' : modelOf(agent.model);
  const resets = cliChanges || modelAfter !== modelOf(agent.model);
  const fits = (!next.orchestrator || next.orchestrator === cliAfter) && modelAfter === modelOf(next.model);
  const effortEdited = has('effort');
  if (effortEdited && next.effort == null) return { send: null, resets };
  if (next.effort && (effortEdited || resets)) {
    if (fits) return { send: next.effort, resets };
    return { resets, ...(effortEdited && { skipped: 'effort not applied: it runs another model' }) };
  }
  return { resets };
}

/** A pushed model or CLI change with no effort edit: say what happens to the effort. */
function withEffortFollowingModel(changes: ManagedTemplateChange[], next: ManagedTemplateSettings, label: SettingLabeler): ManagedTemplateChange[] {
  const touchesModel = changes.some((c) => c.kind === 'setting' && (c.key === 'model' || c.key === 'orchestrator'));
  const effortEdited = changes.some((c) => c.kind === 'setting' && c.key === 'effort');
  if (!touchesModel || effortEdited) return changes;
  // "CLI default" when the template has no effort, else its level, sent with the model.
  return [...changes, { kind: 'setting', key: 'effort', from: 'reset by the new model', to: label('effort', next.effort), followsModel: true }];
}

function pushApplies(change: ManagedTemplateChange, agent: DurableAgentConfig, changes: ManagedTemplateChange[], next: ManagedTemplateSettings, label: SettingLabeler, projectPath?: string): boolean {
  if (change.kind !== 'setting' || change.key !== 'effort') return applies(change, agent, label, projectPath);
  const o = effortOutcome(agent, changes, next);
  if (o.send !== undefined) return o.resets || label('effort', o.send) !== label('effort', agent.effort);
  // No effort sent: it changes only when a new model clears one it has.
  return o.resets && !!agent.effort;
}

function describeSkipped(change: ManagedTemplateChange, agent: DurableAgentConfig, changes: ManagedTemplateChange[], next: ManagedTemplateSettings): string {
  if (change.kind === 'setting' && change.key === 'effort') {
    const o = effortOutcome(agent, changes, next);
    if (o.skipped) return o.skipped;
    return change.followsModel ? 'model unchanged, effort kept' : describeAlready(change);
  }
  return describeAlready(change);
}

function describeAlready(change: ManagedTemplateChange): string {
  if (change.kind === 'add') return `already has ${change.name}`;
  if (change.kind === 'remove') return `already has no ${change.name}`;
  if (change.kind === 'order') return 'order not pushed';
  return `${change.label ?? change.key} already ${change.to}`;
}

function refuseSkillFolderClash(skills: Array<{ name: string; skillName: string }>): void {
  const clash = findSkillFolderClash(skills);
  if (clash) throw new ManagedError('invalid', skillFolderClashMessage(clash.a, clash.b, clash.folder));
}

/** A retired built-in part (D71): its name is free for new parts, since nothing lists it. */
function isRetiredBuiltin(entry: CatalogEntry): boolean {
  return entry.source.kind === 'builtin' && BUILTINS.get(entry.id)?.retired === true;
}

export function isBuiltinPart(id: string): boolean {
  return BUILTINS.has(id);
}

export function builtinPart(id: string): BuiltinPart | undefined {
  return BUILTINS.get(id);
}

export { CLUBHOUSE_MCP_PART_ID };
