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
import { canonicalHash } from '../asset-catalog/planner';
import { AssetCatalogError, installBuiltinAsset, type AssetCatalogStore } from '../asset-catalog/store';
import { auditChanged, auditChanges, withSettingsSurface } from '../settings-audit';
import { appLog } from '../log-service';
import type { AssetPayload, BlockAssetPayload, CatalogEntry, McpAssetPayload, SkillAssetPayload } from '../../../shared/asset-catalog-types';
import type { DurableAgentConfig } from '../../../shared/types';
import {
  CLUBHOUSE_MCP_PART_ID,
  type ManagedAgentSetup,
  type ManagedErrorCode,
  type ManagedPart,
  type ManagedPartConsumer,
  type ManagedPartContent,
  type ManagedPartKind,
  type ManagedPartSummary,
  type ManagedTemplate,
  type ManagedTemplateChange,
  type ManagedTemplatePushTarget,
  type ManagedTemplateSettings,
} from '../../../shared/managed-agents-types';
import { builtinParts, builtinTemplates, DEFAULT_HELPER_TEMPLATE_ID, type BuiltinPart } from './builtins';
import type { ManagedStateStore } from './state-store';

export class ManagedError extends Error {
  constructor(readonly code: ManagedErrorCode, message?: string) {
    super(message ?? code);
  }
}

export interface ManagedAgentsDeps {
  catalog: AssetCatalogStore;
  state: ManagedStateStore;
  listProjects(): Promise<Array<{ path: string; name: string }>>;
  listAgents(projectPath: string): Promise<readonly DurableAgentConfig[]>;
  getAgent(projectPath: string, agentId: string): Promise<DurableAgentConfig | null>;
  setManagedSetup(projectPath: string, agentId: string, setup: ManagedAgentSetup | null): Promise<void>;
  isRunning(agentId: string): boolean;
  /** Called after anything that may change what an agent gets, so the UI can refresh. */
  onChanged?(): void;
  /** Called after an agent stops being managed, to remove what Clubhouse added to its folder for itself. Never throws. */
  onUnmanaged?(projectPath: string, agent: DurableAgentConfig): Promise<void>;
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
        if (agent.managed && !agent.disposedAt) out.push({ projectPath: project.path, projectName: project.name, agent });
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

  async function allTemplates(): Promise<ManagedTemplate[]> {
    const s = await state.read();
    return [...BUILTIN_TEMPLATES.values(), ...Object.values(s.templates)];
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
      revision: entry.headRevision,
      updatedAt: head?.savedAt ?? entry.createdAt,
      ...(meta.updatedBy && { updatedBy: meta.updatedBy }),
      ...(meta.forkedFrom && live[meta.forkedFrom] && { forkedFrom: meta.forkedFrom }),
      usedBy,
      templates: tpls.map((t) => ({ id: t.id, name: t.name })),
      preview: previewOf(content),
      ...(droppedEnvValues.length > 0 && { droppedEnvValues }),
    };
  }

  async function uniqueName(kind: ManagedPartKind, wanted: string, exceptId?: string): Promise<string> {
    const names = new Set(Object.values(await liveEntries()).filter((e) => e.kind === kind && e.id !== exceptId).map((e) => e.name.toLowerCase()));
    if (!names.has(wanted.toLowerCase())) return wanted;
    for (let n = 2; n < 1000; n++) {
      const candidate = `${wanted} ${n}`;
      if (!names.has(candidate.toLowerCase())) return candidate;
    }
    return `${wanted} ${Date.now()}`;
  }

  async function writeAgentSetup(projectPath: string, agentId: string, setup: ManagedAgentSetup): Promise<void> {
    await deps.setManagedSetup(projectPath, agentId, setup);
  }

  const api = {
    /** Install or update the built-in parts. Startup only: runs as Clubhouse itself. */
    async ensureBuiltins(): Promise<void> {
      await withSettingsSurface('system', undefined, async () => {
        const index = await catalog.read();
        for (const part of BUILTINS.values()) {
          const existing = index.assets[part.id];
          if (existing && existing.source.kind !== 'builtin') continue;
          if (existing && !existing.deletedAt) {
            const current = await catalog.readRevision(part.id, existing.headRevision).catch((): null => null);
            if (current && canonicalHash(current) === canonicalHash(part.payload)) continue;
          }
          await installBuiltinAsset(catalog, {
            assetId: part.id, kind: part.kind, name: part.name, builtinId: part.id,
            expectedRevision: existing?.headRevision ?? 0, payload: part.payload,
          });
        }
      });
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

    async createPart(input: { name: string; description?: string; content: ManagedPartContent; actor?: string }): Promise<ManagedPartSummary> {
      const kind = input.content.kind;
      const name = input.name.trim();
      if (!name) throw new ManagedError('invalid', 'Give it a name.');
      refuseEnvValues(input.content);
      const taken = (await liveEntries());
      if (Object.values(taken).some((e) => e.kind === kind && e.name.toLowerCase() === name.toLowerCase())) {
        throw new ManagedError('name_taken', `${name} already exists. Use it, or pick another name.`);
      }
      let entry: CatalogEntry;
      try {
        entry = await catalog.createAsset({ kind, name, payload: contentToPayload(input.content) });
      } catch (err) {
        // telemetry-exempt: rethrown as a ManagedError with a code the caller shows.
        mapCatalogError(err);
      }
      await state.update((s) => {
        s.parts[entry.id] = { ...(input.description?.trim() && { description: input.description.trim() }), ...(input.actor && { updatedBy: input.actor }) };
      });
      await auditManaged('managed.part.created', entry.id);
      changed();
      return summarize(entry);
    },

    /** Edit a custom part for everyone who uses it. Built-ins are read-only. */
    async updatePart(input: { id: string; expectedRevision: number; name?: string; description?: string; content?: ManagedPartContent; actor?: string }): Promise<ManagedPartSummary> {
      let entry = await entryOf(input.id);
      if (entry.source.kind === 'builtin') throw new ManagedError('builtin_read_only', 'Built-in parts can\'t be edited. Make your copy instead.');
      if (entry.headRevision !== input.expectedRevision) throw new ManagedError('stale', 'It changed since you opened it.');
      refuseEnvValues(input.content);
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
        if (input.name !== undefined && input.name.trim() && input.name.trim() !== entry.name) {
          const name = input.name.trim();
          if (Object.values(await liveEntries()).some((e) => e.kind === entry.kind && e.id !== entry.id && e.name.toLowerCase() === name.toLowerCase())) {
            throw new ManagedError('name_taken', `${name} already exists.`);
          }
          entry = await catalog.renameAsset({ assetId: entry.id, expectedName: entry.name, name });
        }
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
        if (input.actor) meta.updatedBy = input.actor;
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
        s.parts[copy.id] = { ...(description && { description }), forkedFrom: entry.id, ...(input.actor && { updatedBy: input.actor }) };
      });
      await auditManaged('managed.part.created', copy.id);
      if (agent && input.agent) {
        await writeAgentSetup(input.agent.projectPath, input.agent.agentId, replaceIn(agent.managed!, entry.id, copy.id));
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
      await writeAgentSetup(input.projectPath, input.agentId, replaceIn(agent.managed, input.id, origin));
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
          await writeAgentSetup(projectPath, agent.id, replaceIn(setup, entry.id, copy.id));
        } else {
          await writeAgentSetup(projectPath, agent.id, replaceIn(setup, entry.id, null));
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
      return agent.managed ?? null;
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
        mcps: clean(setup.mcps, 'mcp'),
        ...(setup.templateId && { templateId: setup.templateId }),
      };
      // Two skills that deliver to one folder can't both reach the agent.
      const folders = new Set<string>();
      for (const id of next.skills) {
        const content = await contentOf(live[id]);
        const folder = content.kind === 'skill' ? content.skillName.toLowerCase() : id;
        if (folders.has(folder)) throw new ManagedError('invalid', `Two skills use the folder name ${folder}. Remove one, or rename a copy.`);
        folders.add(folder);
      }
      for (const name of planned.skillFolders ?? []) {
        const folder = name.toLowerCase();
        if (folders.has(folder)) throw new ManagedError('invalid', `Two skills use the folder name ${folder}. Remove one, or rename a copy.`);
        folders.add(folder);
      }
      return next;
    },

    /** Save what an agent is built from, after checkSetup's checks. */
    async saveSetup(projectPath: string, agentId: string, setup: Omit<ManagedAgentSetup, 'version'>): Promise<ManagedAgentSetup> {
      const agent = await deps.getAgent(projectPath, agentId);
      if (!agent) throw new ManagedError('not_found');
      if (!agent.worktreePath) throw new ManagedError('invalid', `${agent.name} works in the project folder. Managed agents need their own folder.`);
      const next = await api.checkSetup(setup);
      await writeAgentSetup(projectPath, agentId, next);
      changed();
      return next;
    },

    /**
     * Stop managing an agent. It keeps the last files Clubhouse wrote, except
     * the settings Clubhouse added for itself, which onUnmanaged removes.
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

    async saveTemplate(input: Omit<ManagedTemplate, 'builtin' | 'updatedAt' | 'id'> & { id?: string }): Promise<ManagedTemplate> {
      if (input.id && BUILTIN_TEMPLATES.has(input.id)) throw new ManagedError('builtin_read_only', 'Built-in templates can\'t be edited. Make your copy instead.');
      const name = input.name.trim();
      if (!name) throw new ManagedError('invalid', 'Give it a name.');
      const live = await liveEntries();
      const keep = (ids: string[]) => ids.filter((id) => live[id]);
      const template = await state.update((s) => {
        const id = input.id ?? `template-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
        if (input.id && !s.templates[input.id]) throw new ManagedError('not_found');
        const clash = [...BUILTIN_TEMPLATES.values(), ...Object.values(s.templates)].some((t) => t.id !== id && t.name.toLowerCase() === name.toLowerCase());
        if (clash) throw new ManagedError('name_taken', `A template called ${name} already exists.`);
        const t: ManagedTemplate = {
          id, name, description: input.description?.trim() ?? '', builtin: false,
          setup: { blocks: keep(input.setup.blocks), skills: keep(input.setup.skills), mcps: keep(input.setup.mcps) },
          settings: { ...input.settings },
          updatedAt: new Date().toISOString(),
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

    /** Save an agent's whole setup and settings as a new template. */
    async templateFromAgent(projectPath: string, agentId: string, name: string, description = ''): Promise<ManagedTemplate> {
      const agent = await deps.getAgent(projectPath, agentId);
      if (!agent?.managed) throw new ManagedError('not_managed');
      return api.saveTemplate({
        name, description,
        setup: { blocks: agent.managed.blocks, skills: agent.managed.skills, mcps: agent.managed.mcps },
        settings: settingsOf(agent),
      });
    },

    /** The changes an edit makes to a template, and the agents made from it. */
    async previewTemplatePush(id: string, next: Pick<ManagedTemplate, 'setup' | 'settings'>): Promise<{ changes: ManagedTemplateChange[]; targets: ManagedTemplatePushTarget[] }> {
      const current = await api.getTemplate(id);
      const live = await liveEntries();
      const changes = diffTemplates(current, next, (pid) => live[pid]?.name ?? pid);
      const agents = (await managedAgents()).filter(({ agent }) => agent.managed?.templateId === id);
      const targets = agents.map(({ projectPath, agent }) => {
        const applicable = changes.filter((c) => applies(c, agent));
        const skipped = changes.filter((c) => !applies(c, agent));
        return {
          projectPath, agentId: agent.id, agentName: agent.name, color: agent.color, running: deps.isRunning(agent.id),
          applicable: applicable.length, total: changes.length,
          ...(skipped.length > 0 && { note: skipped.map(describeAlready).join(', ') }),
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
    async pushTemplate(id: string, next: Pick<ManagedTemplate, 'setup' | 'settings'>, agents: Array<{ projectPath: string; agentId: string }>): Promise<TemplatePushResult[]> {
      const current = await api.getTemplate(id);
      const live = await liveEntries();
      // Every part the edit names must still exist, as its kind.
      for (const kind of KINDS) {
        for (const pid of listOf({ version: 1, ...next.setup }, kind)) {
          if (live[pid]?.kind !== kind) throw new ManagedError('not_found', 'A part in this template no longer exists. Reload and try again.');
        }
      }
      const changes = diffTemplates(current, next, (pid) => live[pid]?.name ?? pid);
      const settingsOut: TemplatePushResult[] = [];
      for (const target of agents) {
        const agent = await deps.getAgent(target.projectPath, target.agentId);
        if (!agent?.managed || agent.managed.templateId !== id) continue;
        // Nothing applies (it already has every change): skipped, and not saved again.
        if (!changes.some((c) => applies(c, agent))) {
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
          } else if (change.kind === 'setting') {
            mergeSetting(settings, next.settings, change.key);
          }
        }
        try {
          // Through saveSetup, so each agent's result is checked (skill folders, missing parts).
          await api.saveSetup(target.projectPath, target.agentId, setup);
          settingsOut.push({ ...target, settings, changed: true });
        } catch (err) {
          // telemetry-exempt: reported to the caller per agent, and shown in the push dialog.
          settingsOut.push({ ...target, settings: {}, changed: false, failed: err instanceof Error ? err.message : String(err) });
        }
      }
      if (!BUILTIN_TEMPLATES.has(id)) {
        await state.update((s) => {
          const t = s.templates[id];
          if (t) s.templates[id] = { ...t, setup: { ...next.setup }, settings: { ...next.settings }, updatedAt: new Date().toISOString() };
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
      if (id && (BUILTIN_TEMPLATES.has(id) || s.templates[id])) return id;
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
        setup: { version: 1, blocks: keep(t.setup.blocks), skills: keep(t.setup.skills), mcps: keep(t.setup.mcps), templateId: t.id },
        settings: { ...t.settings },
      };
    },

    /** Read a part's head content, for delivery. */
    async headContent(id: string): Promise<{ entry: CatalogEntry; content: ManagedPartContent; droppedEnvValues: string[] } | null> {
      const live = await liveEntries();
      const entry = live[id];
      if (!entry) return null;
      return { entry, ...(await readHead(entry)) };
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

export function settingsOf(agent: DurableAgentConfig): ManagedTemplateSettings {
  return {
    ...(agent.orchestrator && { orchestrator: agent.orchestrator }),
    ...(agent.model && { model: agent.model }),
    ...(agent.freeAgentMode !== undefined && { freeAgentMode: agent.freeAgentMode }),
    ...(agent.orchestration && Object.keys(agent.orchestration).length > 0 && { orchestration: { ...agent.orchestration } }),
  };
}

function settingLabel(value: unknown): string {
  if (value === undefined) return 'unset';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function flattenSettings(settings: ManagedTemplateSettings): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (settings.orchestrator !== undefined) out.orchestrator = settings.orchestrator;
  if (settings.model !== undefined) out.model = settings.model;
  if (settings.freeAgentMode !== undefined) out.freeAgentMode = settings.freeAgentMode;
  for (const [k, v] of Object.entries(settings.orchestration ?? {})) out[`orchestration.${k}`] = v;
  return out;
}

/**
 * Add one changed setting to what gets applied. A setting the template no
 * longer sets goes back to the default: null for orchestration fields, the
 * CLI default model, Free Agent Mode off. The CLI is never unset.
 */
function mergeSetting(out: ManagedTemplateSettings, from: ManagedTemplateSettings, key: string): void {
  if (key.startsWith('orchestration.')) {
    const k = key.slice('orchestration.'.length);
    const value = (from.orchestration as Record<string, unknown> | undefined)?.[k];
    out.orchestration = { ...(out.orchestration ?? {}), [k]: value === undefined ? null : value } as ManagedTemplateSettings['orchestration'];
    return;
  }
  if (key === 'model') out.model = from.model ?? 'default';
  else if (key === 'freeAgentMode') out.freeAgentMode = from.freeAgentMode ?? false;
  else if (key === 'orchestrator' && from.orchestrator) out.orchestrator = from.orchestrator;
}

export function diffTemplates(
  current: Pick<ManagedTemplate, 'setup' | 'settings'>,
  next: Pick<ManagedTemplate, 'setup' | 'settings'>,
  nameOf: (id: string) => string,
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
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) changes.push({ kind: 'setting', key, from: settingLabel(a[key]), to: settingLabel(b[key]) });
  }
  return changes;
}

function applies(change: ManagedTemplateChange, agent: DurableAgentConfig): boolean {
  const setup = agent.managed!;
  if (change.kind === 'add') return !listOf(setup, change.part).includes(change.id);
  if (change.kind === 'remove') return listOf(setup, change.part).includes(change.id);
  if (change.kind === 'order') return false;
  const flat = flattenSettings(settingsOf(agent));
  return settingLabel(flat[change.key]) !== change.to;
}

function describeAlready(change: ManagedTemplateChange): string {
  if (change.kind === 'add') return `already has ${change.name}`;
  if (change.kind === 'remove') return `already has no ${change.name}`;
  if (change.kind === 'order') return 'order not pushed';
  return `${change.key} already ${change.to}`;
}

export function isBuiltinPart(id: string): boolean {
  return BUILTINS.has(id);
}

export function builtinPart(id: string): BuiltinPart | undefined {
  return BUILTINS.get(id);
}

export { CLUBHOUSE_MCP_PART_ID };
