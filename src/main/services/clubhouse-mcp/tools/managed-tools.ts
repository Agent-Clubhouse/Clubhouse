/**
 * Builder tools (#2900), in the `dispatcher` tool group: every builder
 * action as a Clubhouse MCP tool, so the
 * Dispatcher can manage agent parts, templates and managed agents for the
 * person. They call the same service the UI does. Shared edits, deleting a
 * part in use and template pushes are preview-then-commit: the first call
 * returns who it reaches and a confirm token, the second commits with it.
 */
import { createHash, randomBytes } from 'crypto';
import { registerGlobalTool } from '../tool-registry';
import type { McpToolResult } from '../types';
import { appLog } from '../../log-service';
import * as projectStore from '../../project-store';
import * as agentConfig from '../../agent-config';
import { withDispatcherCatalogWrites } from '../../asset-catalog/store';
import { managedAgents, restartManagedAgent, statusFor } from '../../managed-agents';
import { applyManagedSettings, createManagedAgent } from '../../managed-agents/agents';
import { previewManagedSetup } from '../../managed-agents/delivery';
import { ManagedError } from '../../managed-agents/service';
import { resolveOrchestrator } from '../../agent-system';
import { optionalBoolean, optionalString, requireString } from './validation';
import { CLUBHOUSE_MCP_PART_ID, CLUBHOUSE_PART_ALWAYS_ON, isListed, type ManagedPartContent, type ManagedPartKind, type ManagedTemplateSettings } from '../../../../shared/managed-agents-types';
import type { Project } from '../../../../shared/types';

const ACTOR = 'Dispatcher';
const KINDS: ManagedPartKind[] = ['block', 'skill', 'mcp'];

/** A saved result, with a note when the call left out the Clubhouse part, which is kept anyway. */
function keptClubhousePart<T extends object>(asked: string[], saved: T): T | (T & { note: string }) {
  return asked.includes(CLUBHOUSE_MCP_PART_ID) ? saved : { ...saved, note: CLUBHOUSE_PART_ALWAYS_ON };
}

function json(value: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}
function fail(text: string): McpToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

class ArgError extends Error {}

/** A refused stale edit: what the part is now, so the caller can read it and decide (D88). */
function staleText(part: { name: string; revision: number; updatedAt: string; updatedBy?: string }): string {
  const by = part.updatedBy ? ` by ${part.updatedBy}` : '';
  return `${part.name} changed since you read it. It is at revision ${part.revision} now, saved${by} at ${part.updatedAt}. Read it with get_agent_part, then call again with expectedRevision ${part.revision} if your change should still go in.`;
}

function kindArg(args: Record<string, unknown>): ManagedPartKind {
  const kind = requireString(args, 'kind');
  if (!(KINDS as string[]).includes(kind)) throw new ArgError(`kind must be one of ${KINDS.join(', ')}`);
  return kind as ManagedPartKind;
}
function numberArg(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new ArgError(`${key} must be a positive integer`);
  return v;
}
function idList(args: Record<string, unknown>, key: string): string[] {
  const v = args[key];
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new ArgError(`${key} must be a list of part ids`);
  return v as string[];
}
/** A list argument, or `fallback` when the call left it out. */
function idListOr(args: Record<string, unknown>, key: string, fallback: string[]): string[] {
  return args[key] === undefined ? [...fallback] : idList(args, key);
}
function objectArg<T>(args: Record<string, unknown>, key: string): T | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ArgError(`${key} must be an object`);
  return v as T;
}
function contentArg(args: Record<string, unknown>, kind?: ManagedPartKind): ManagedPartContent | undefined {
  const c = objectArg<Record<string, unknown>>(args, 'content');
  if (!c) return undefined;
  const k = (c.kind as string) ?? kind;
  if (k === 'block' && typeof c.content === 'string') return { kind: 'block', content: c.content };
  if (k === 'skill' && typeof c.skillName === 'string' && Array.isArray(c.files)) return { kind: 'skill', skillName: c.skillName, files: c.files as never };
  if (k === 'mcp' && typeof c.serverKey === 'string' && typeof c.transport === 'string') return { ...(c as object), kind: 'mcp' } as ManagedPartContent;
  throw new ArgError('content does not match its kind: block {content}, skill {skillName, files}, mcp {serverKey, transport, command|url, args?, envVars?}');
}

async function resolveProject(ref: string): Promise<Project> {
  const projects = await projectStore.peekProjects();
  const lower = ref.toLowerCase();
  const found = projects.find((p) => p.path === ref)
    ?? projects.find((p) => (p.displayName || p.name).toLowerCase() === lower || p.name.toLowerCase() === lower);
  if (!found) throw new ArgError(`No registered project matches "${ref}". Call list_projects for names.`);
  return found;
}

async function resolveAgent(args: Record<string, unknown>): Promise<{ project: Project; agentId: string; agentName: string }> {
  const project = await resolveProject(requireString(args, 'project'));
  const ref = requireString(args, 'agent');
  const agents = await agentConfig.listDurable(project.path);
  const agent = agents.find((a) => a.id === ref) ?? agents.find((a) => a.name === ref);
  if (!agent) throw new ArgError(`No agent "${ref}" in ${project.name}.`);
  return { project, agentId: agent.id, agentName: agent.name };
}

// ── Confirm tokens ──────────────────────────────────────────────────────
//
// A preview issues a random token, kept here for the calling agent only. It
// is bound to a digest of what the preview showed (the part's revision and
// content, or the template's saved setup, settings and updatedAt, plus the
// edit and the agents chosen), expires after ten minutes, and is used up by
// the first call that presents it. A commit recomputes the digest from the
// current state: anything changed since the preview refuses it.

export const CONFIRM_TTL_MS = 10 * 60_000;
/** Tokens kept per caller; the oldest goes first past this. */
const MAX_TOKENS_PER_CALLER = 50;

const issuedTokens = new Map<string, Map<string, { digest: string; expiresAt: number }>>();

function digestOf(...parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function issueConfirm(callerId: string, digest: string): string {
  const now = Date.now();
  const mine = issuedTokens.get(callerId) ?? new Map<string, { digest: string; expiresAt: number }>();
  for (const [t, v] of mine) if (v.expiresAt <= now) mine.delete(t);
  while (mine.size >= MAX_TOKENS_PER_CALLER) mine.delete(mine.keys().next().value as string);
  const token = randomBytes(16).toString('hex');
  mine.set(token, { digest, expiresAt: now + CONFIRM_TTL_MS });
  issuedTokens.set(callerId, mine);
  return token;
}

/** Use up a token. Throws ArgError unless it was issued to this caller, is unexpired, and matches what is there now. */
function redeemConfirm(callerId: string, token: string, digest: string): void {
  const mine = issuedTokens.get(callerId);
  const entry = mine?.get(token);
  if (!entry) throw new ArgError('That confirm token wasn\'t issued to you, or was already used. Call again without confirm for a new preview.');
  mine!.delete(token);
  if (entry.expiresAt <= Date.now()) throw new ArgError('That confirm token expired. Call again without confirm for a new preview.');
  if (entry.digest !== digest) throw new ArgError('stale: it changed since the preview, or the arguments differ from it. Call again without confirm for a new preview.');
}

/** Tests only. */
export function _resetConfirmTokensForTesting(): void {
  issuedTokens.clear();
}

/** Run service writes under the calling Dispatcher's catalog write grant, and nothing else (#2900). */
function asDispatcher<T>(callerId: string, fn: () => Promise<T>): Promise<T> {
  return withDispatcherCatalogWrites(callerId, fn);
}

type Handler = (callerId: string, args: Record<string, unknown>) => Promise<McpToolResult>;

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[], handler: Handler): void {
  registerGlobalTool(name, { description, inputSchema: { type: 'object', properties, required } }, async (callerId, args) => {
    try {
      // Writes run under asDispatcher, which attributes them to the calling Dispatcher (#2900).
      return await handler(callerId, args);
    } catch (err) {
      // telemetry-exempt: the error reaches the Dispatcher as the tool result
      if (err instanceof ArgError) return fail(err.message);
      if (err instanceof ManagedError) return fail(`${err.code}: ${err.message}`);
      appLog('core:mcp', 'warn', `${name} failed`, { meta: { callerId, error: err instanceof Error ? err.message : String(err) } });
      return fail(err instanceof Error ? err.message : String(err));
    }
  }, { group: 'dispatcher' });
}

const S = { type: 'string' } as const;
const IDS = { type: 'array', items: { type: 'string' } } as const;
const OBJ = { type: 'object' } as const;
const PROJECT = { type: 'string', description: 'Project name or path, from list_projects.' } as const;
const AGENT = { type: 'string', description: 'Agent id or name, from list_agents.' } as const;

export function registerManagedTools(): void {
  const svc = () => managedAgents();

  tool('list_agent_parts',
    'List the agent part library: instruction blocks, skills or MCP servers. Each part says whether it is built in, a short preview, and which agents and templates use it. Parts are used by reference: an edit reaches every agent using it at its next start. Retired built-ins are left out; agents that use one still get it, and get_agent_part reads it. source "builtin" or "custom" lists only those, as the library\'s source filter does.',
    { kind: { ...S, description: 'block, skill or mcp' }, source: { ...S, description: 'Optional: builtin or custom. Leave out for both.' } }, ['kind'],
    async (_c, args) => {
      const kind = kindArg(args);
      const source = optionalString(args, 'source');
      if (source !== undefined && source !== 'builtin' && source !== 'custom') throw new ArgError('source must be builtin or custom');
      const parts = (await svc().listParts(kind)).filter(isListed);
      return json(source === undefined ? parts : parts.filter((p) => p.builtin === (source === 'builtin')));
    });

  tool('get_agent_part', 'Read one agent part with its full content and revision.',
    { id: S }, ['id'],
    async (_c, args) => json(await svc().getPart(requireString(args, 'id'))));

  tool('create_agent_part',
    'Create a custom agent part in the library. It is not added to any agent; use set_agent_setup for that. content: block {content}, skill {skillName, files: [{path, content, encoding?, executable?}]}, mcp {serverKey, transport: stdio|http|sse, command?, args?, url?, envVars?: names only}. Never put secret values in parts.',
    { kind: S, name: S, description: S, content: OBJ }, ['kind', 'name', 'content'],
    async (callerId, args) => {
      const kind = kindArg(args);
      const content = contentArg(args, kind);
      if (!content || content.kind !== kind) throw new ArgError('content must match kind');
      const input = { name: requireString(args, 'name'), description: optionalString(args, 'description'), content, actor: ACTOR };
      return json(await asDispatcher(callerId, () => svc().createPart(input)));
    });

  tool('update_agent_part',
    'Edit or rename a custom part for every agent that uses it. Built-ins are read-only: fork them. When more than one agent uses it, the first call returns the agents and templates it reaches and a confirm token; call again with the same arguments and confirm to save. A token is yours only, works once, and expires after 10 minutes. Running agents keep their current setup until restarted.',
    { id: S, expectedRevision: { type: 'number' }, name: S, description: S, content: OBJ, confirm: S }, ['id', 'expectedRevision'],
    async (callerId, args) => {
      const id = requireString(args, 'id');
      const expectedRevision = numberArg(args, 'expectedRevision');
      const content = contentArg(args);
      const name = optionalString(args, 'name');
      const description = optionalString(args, 'description');
      const part = await svc().getPart(id);
      if (part.builtin) throw new ManagedError('builtin_read_only', 'Built-in parts can\'t be edited. Fork it with fork_agent_part instead.');
      // Never saved over a newer version: say what is there now, so the caller can read it and decide.
      if (part.revision !== expectedRevision) throw new ManagedError('stale', staleText(part));
      const digest = digestOf('update_agent_part', id, part.revision, part.content, expectedRevision, content ?? null, name ?? null, description ?? null,
        part.usedBy.map((c) => c.agentId).sort(), part.templates.map((t) => t.id).sort());
      const given = optionalString(args, 'confirm');
      if (given) redeemConfirm(callerId, given, digest);
      else if (part.usedBy.length > 1) {
        return json({ status: 'needs_confirmation', confirm: issueConfirm(callerId, digest),
          reaches: part.usedBy.map((c) => ({ agent: c.agentName, project: c.projectName, running: c.running })),
          templates: part.templates.map((t) => t.name),
          note: 'Call again with the same arguments and this confirm token to save. Each agent gets the change at its next start; running ones keep their setup until restarted. Agents made from these templates later get it too.' });
      }
      return json(await asDispatcher(callerId, () => svc().updatePart({ id, expectedRevision, name, description, content, actor: ACTOR })));
    });

  tool('fork_agent_part',
    'Make a custom copy of a part in the library (forking a built-in is how to change one). With project and agent, that agent switches to the copy and the others keep the original.',
    { id: S, project: PROJECT, agent: AGENT, name: S }, ['id'],
    async (callerId, args) => {
      const id = requireString(args, 'id');
      const target = args.agent !== undefined ? await resolveAgent(args) : null;
      const input = { id, ...(target && { agent: { projectPath: target.project.path, agentId: target.agentId } }), name: optionalString(args, 'name'), actor: ACTOR };
      return json(await asDispatcher(callerId, () => svc().forkPart(input)));
    });

  tool('delete_agent_part',
    'Delete a custom part. mode "copy" gives each agent that uses it its own copy; "remove" takes it out of those agents. Templates drop it either way. When agents or templates use it, the first call returns them and a confirm token; call again with the same arguments and confirm to delete.',
    { id: S, expectedRevision: { type: 'number' }, mode: { ...S, description: 'copy or remove' }, confirm: S }, ['id', 'expectedRevision', 'mode'],
    async (callerId, args) => {
      const id = requireString(args, 'id');
      const expectedRevision = numberArg(args, 'expectedRevision');
      const mode = requireString(args, 'mode');
      if (mode !== 'copy' && mode !== 'remove') throw new ArgError('mode must be copy or remove');
      const part = await svc().getPart(id);
      if (part.builtin) throw new ManagedError('builtin_read_only', 'Built-in parts can\'t be deleted.');
      if (part.revision !== expectedRevision) throw new ManagedError('stale', staleText(part));
      const digest = digestOf('delete_agent_part', id, part.revision, part.content, expectedRevision, mode,
        part.usedBy.map((c) => c.agentId).sort(), part.templates.map((t) => t.id).sort());
      const given = optionalString(args, 'confirm');
      if (given) redeemConfirm(callerId, given, digest);
      else if (part.usedBy.length > 0 || part.templates.length > 0) {
        return json({ status: 'needs_confirmation', confirm: issueConfirm(callerId, digest),
          reaches: part.usedBy.map((c) => ({ agent: c.agentName, project: c.projectName, running: c.running })),
          templates: part.templates.map((t) => t.name),
          note: `${mode === 'copy' ? 'Each agent gets its own copy of the part.' : 'The part is taken out of each agent.'} The templates drop it. Call again with the same arguments and this confirm token to delete.` });
      }
      await asDispatcher(callerId, () => svc().deletePart({ id, expectedRevision, mode }));
      return json({ status: 'deleted' });
    });

  tool('get_agent_setup',
    'Read what a managed agent is built from (block ids in order, skill ids, MCP ids, its template) and whether a running session is behind its setup.',
    { project: PROJECT, agent: AGENT }, ['project', 'agent'],
    async (_c, args) => {
      const t = await resolveAgent(args);
      return json({ setup: await svc().getSetup(t.project.path, t.agentId), status: await statusFor(t.project.path, t.agentId) });
    });

  tool('set_agent_setup',
    'Replace a managed agent\'s parts: blocks in the order it reads them, skills and MCP servers. The Clubhouse MCP part always stays in the setup. Applies at its next start; use restart_agent for a running one.',
    { project: PROJECT, agent: AGENT, blocks: IDS, skills: IDS, mcps: IDS }, ['project', 'agent', 'blocks', 'skills', 'mcps'],
    async (callerId, args) => {
      const t = await resolveAgent(args);
      const current = await svc().getSetup(t.project.path, t.agentId);
      if (!current) throw new ArgError(`${t.agentName} isn't Clubhouse managed.`);
      const next = { ...current, blocks: idList(args, 'blocks'), skills: idList(args, 'skills'), mcps: idList(args, 'mcps') };
      const saved = await asDispatcher(callerId, () => svc().saveSetup(t.project.path, t.agentId, next));
      // Leaving the Clubhouse part out is ignored: saveSetup keeps it, and the result says so.
      return json(keptClubhousePart(next.mcps, saved));
    });

  tool('preview_agent_setup',
    'The exact result a managed agent gets at its next start: instruction text with each block\'s lines, skills and where they go, MCP servers.',
    { project: PROJECT, agent: AGENT }, ['project', 'agent'],
    async (_c, args) => {
      const t = await resolveAgent(args);
      const agent = await agentConfig.getDurableConfig(t.project.path, t.agentId);
      if (!agent?.managed) throw new ArgError(`${t.agentName} isn't Clubhouse managed.`);
      const provider = await resolveOrchestrator(t.project.path, agent.orchestrator).catch((): undefined => undefined);
      return json(await previewManagedSetup({ service: svc(), projectPath: t.project.path, agent, provider }));
    });

  tool('list_agent_templates', 'List templates (built-in and custom) with their parts, settings and how many agents were made from each. Retired built-in templates are left out; agents made from one keep working.',
    {}, [],
    async () => json((await svc().listTemplates()).filter(isListed)));

  tool('save_agent_template',
    'Create a custom template (name required), or edit one by id. Editing an id keeps every field you leave out as saved; settings, when given, replaces the template\'s settings as a whole. Editing changes future agents only; use push_agent_template to apply it to agents made from it. settings: orchestrator, model, freeAgentMode, orchestration {...}.',
    { id: S, name: S, description: S, blocks: IDS, skills: IDS, mcps: IDS, settings: OBJ }, [],
    async (callerId, args) => {
      const id = optionalString(args, 'id');
      const settings = objectArg<ManagedTemplateSettings>(args, 'settings');
      if (!id) {
        const input = {
          name: requireString(args, 'name'), description: optionalString(args, 'description') ?? '',
          setup: { blocks: idList(args, 'blocks'), skills: idList(args, 'skills'), mcps: idList(args, 'mcps') },
          settings: settings ?? {},
        };
        return json(keptClubhousePart(input.setup.mcps, await asDispatcher(callerId, () => svc().saveTemplate(input))));
      }
      // An edit merges what the call gave into the saved template.
      const current = await svc().getTemplate(id);
      const input = {
        id,
        name: optionalString(args, 'name') ?? current.name,
        description: optionalString(args, 'description') ?? current.description,
        setup: {
          blocks: idListOr(args, 'blocks', current.setup.blocks),
          skills: idListOr(args, 'skills', current.setup.skills),
          mcps: idListOr(args, 'mcps', current.setup.mcps),
        },
        settings: settings ?? current.settings,
      };
      return json(keptClubhousePart(input.setup.mcps, await asDispatcher(callerId, () => svc().saveTemplate(input))));
    });

  tool('push_agent_template',
    'Save a template edit and apply its changes to agents made from it. Call once without confirm, naming in agents the agent ids to apply to: it returns the changes, every agent made from the template with how many changes apply to each, and a confirm token for that choice. Then call again with the same arguments and confirm. Settings left out stay as the template has them. A token is yours only, works once, expires after 10 minutes, and is refused if the template changed since the preview.',
    { id: S, blocks: IDS, skills: IDS, mcps: IDS, settings: OBJ, agents: IDS, confirm: S }, ['id', 'blocks', 'skills', 'mcps'],
    async (callerId, args) => {
      const id = requireString(args, 'id');
      const current = await svc().getTemplate(id);
      const next = {
        setup: { blocks: idList(args, 'blocks'), skills: idList(args, 'skills'), mcps: idList(args, 'mcps') },
        settings: objectArg<ManagedTemplateSettings>(args, 'settings') ?? current.settings,
      };
      const preview = await svc().previewTemplatePush(id, next);
      const chosen = [...new Set(idList(args, 'agents'))].sort();
      const unknown = chosen.filter((a) => !preview.targets.some((t) => t.agentId === a));
      if (unknown.length > 0) throw new ArgError(`Not made from this template: ${unknown.join(', ')}. Pick agent ids from the preview's agents.`);
      const digest = digestOf('push_agent_template', id, current.setup, current.settings, current.updatedAt ?? null, next, chosen);
      const given = optionalString(args, 'confirm');
      if (!given) {
        return json({ status: 'needs_confirmation', confirm: issueConfirm(callerId, digest), changes: preview.changes, agents: preview.targets, applyTo: chosen,
          note: 'Call again with the same arguments and this confirm token. To apply to other agents, preview again with them in agents.' });
      }
      redeemConfirm(callerId, given, digest);
      const targets = preview.targets.filter((t) => chosen.includes(t.agentId)).map((t) => ({ projectPath: t.projectPath, agentId: t.agentId }));
      const results = await asDispatcher(callerId, () => svc().pushTemplate(id, next, targets));
      const failed: Array<{ agentId: string; message: string }> = [];
      let applied = 0;
      for (const r of results) {
        if (r.failed) { failed.push({ agentId: r.agentId, message: r.failed }); continue; }
        if (!r.changed) continue;
        try {
          await asDispatcher(callerId, () => applyManagedSettings(r.projectPath, r.agentId, r.settings));
          applied++;
        } catch (err) {
          // telemetry-exempt: reported to the Dispatcher per agent in the result
          failed.push({ agentId: r.agentId, message: err instanceof Error ? err.message : String(err) });
        }
      }
      const skipped = results.filter((r) => !r.failed && !r.changed).map((r) => r.agentId);
      return json({ status: 'pushed', applied, ...(skipped.length > 0 && { skipped }), failed });
    });

  tool('delete_agent_template',
    'Delete a custom template. Built-in templates can\'t be deleted. Agents made from it keep their setup; new agents and helpers can\'t start from it, and if it was the default helper template, helpers go back to the built-in Helper template. The first call returns the agents made from it and a confirm token; call again with the same id and confirm to delete.',
    { id: S, confirm: S }, ['id'],
    async (callerId, args) => {
      const id = requireString(args, 'id');
      const template = await svc().getTemplate(id);
      if (template.builtin) throw new ManagedError('builtin_read_only', 'Built-in templates can\'t be deleted.');
      const agents = await svc().templateConsumers(id);
      const isDefaultHelper = (await svc().defaultHelperTemplateId()) === id;
      const digest = digestOf('delete_agent_template', id, template.updatedAt ?? null, agents.map((a) => a.agentId).sort(), isDefaultHelper);
      const given = optionalString(args, 'confirm');
      if (!given) {
        return json({ status: 'needs_confirmation', confirm: issueConfirm(callerId, digest),
          madeFromIt: agents.map((c) => ({ agent: c.agentName, project: c.projectName, running: c.running })),
          ...(isDefaultHelper && { defaultHelperTemplate: true }),
          note: `Agents made from ${template.name} keep their setup. New agents can't start from it.${isDefaultHelper ? ' It is the default helper template, so new helpers use the built-in Helper template instead.' : ''} Call again with the same id and this confirm token to delete.` });
      }
      redeemConfirm(callerId, given, digest);
      await asDispatcher(callerId, () => svc().deleteTemplate(id));
      return json({ status: 'deleted' });
    });

  tool('create_managed_agent',
    'Create a durable agent, asleep; wake it with wake_agent. By default it is Clubhouse managed, from a template or a full setup, in its own worktree (or folder). managed: false makes a plain agent instead, in its own worktree, that reads its own files; it takes settings but no template or parts.',
    { project: PROJECT, name: S, color: S, managed: { type: 'boolean', description: 'false for a plain (unmanaged) agent. Default true.' }, templateId: S, blocks: IDS, skills: IDS, mcps: IDS, settings: OBJ }, ['project', 'name'],
    async (callerId, args) => {
      const project = await resolveProject(requireString(args, 'project'));
      const hasSetup = ['blocks', 'skills', 'mcps'].some((k) => args[k] !== undefined);
      const plain = optionalBoolean(args, 'managed') === false;
      if (plain && (hasSetup || args.templateId !== undefined)) throw new ArgError('A plain agent has no template or parts. Leave out templateId, blocks, skills and mcps, or leave out managed: false.');
      const input = {
        name: requireString(args, 'name'),
        color: optionalString(args, 'color') ?? 'indigo',
        ...(plain && { managed: false as const }),
        templateId: optionalString(args, 'templateId'),
        ...(hasSetup && { setup: { blocks: idList(args, 'blocks'), skills: idList(args, 'skills'), mcps: idList(args, 'mcps') } }),
        settings: objectArg<ManagedTemplateSettings>(args, 'settings'),
      };
      // Created asleep: nothing here spawns, so the whole creation can run under the grant.
      const config = await asDispatcher(callerId, () => createManagedAgent(project.path, input));
      return json({ id: config.id, name: config.name, project: project.name, managed: !!config.managed, status: 'sleeping' });
    });

  tool('restart_agent',
    'Restart a running managed agent so it picks up its setup. By default it waits for the agent\'s current turn to end first; now: true restarts it at once, cutting the turn off. It resumes the same conversation unless fresh is true, or the CLI changed. Only running managed agents, and never yourself: a sleeping agent gets its setup when it next starts (wake_agent).',
    { project: PROJECT, agent: AGENT, fresh: { type: 'boolean' }, now: { type: 'boolean', description: 'Restart at once instead of after the current turn.' } }, ['project', 'agent'],
    async (callerId, args) => {
      const t = await resolveAgent(args);
      if (t.agentId === callerId) throw new ArgError('You can\'t restart yourself.');
      const status = await statusFor(t.project.path, t.agentId);
      if (!status.managed) throw new ArgError(`${t.agentName} isn't Clubhouse managed. restart_agent only restarts managed agents.`);
      if (!status.running) throw new ArgError(`${t.agentName} isn't running. It gets its setup when it next starts; restart_agent never wakes an agent.`);
      const now = optionalBoolean(args, 'now') === true;
      // No catalog grant: a restart writes no parts, and the spawn must not inherit one.
      const restart = restartManagedAgent(t.project.path, t.agentId, { fresh: optionalBoolean(args, 'fresh'), whenTurnEnds: !now });
      const answer = (r: { resumed: boolean; noSession?: boolean }) => json({ status: 'restarted', resumed: r.resumed,
        ...(r.noSession && { note: 'There was no conversation to resume, so it started a new one.' }) });
      if (now) return answer(await restart);
      // Waiting for a turn can take long: answer after a short wait, and let the restart finish behind it.
      const done = await settleWithin(restart, RESTART_ANSWER_MS);
      if (done) return answer(done);
      restart.catch((err: unknown) => {
        // telemetry-exempt: the Dispatcher already has its answer; the failure is logged
        appLog('core:mcp', 'warn', 'restart_agent: restart after the turn failed', { meta: { callerId, agentId: t.agentId, error: err instanceof Error ? err.message : String(err) } });
      });
      return json({ status: 'waiting_for_turn_end', note: `${t.agentName} is mid-turn. It restarts when the turn ends, or not at all if it is still working after 30 minutes. Check with get_agent_setup.` });
    });
}

/** How long restart_agent waits for a restart after the turn before it answers. */
const RESTART_ANSWER_MS = 10_000;

/** The promise's value if it settles within `ms`, or null. Rejects if it rejects within `ms`. */
async function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
