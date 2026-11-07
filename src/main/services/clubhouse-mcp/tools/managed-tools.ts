/**
 * Builder tools (#2900), in the `dispatcher` tool group: every builder action
 * as a Clubhouse MCP tool, so the Dispatcher can manage agent parts,
 * templates and managed agents for the person. They call the same service
 * the UI does. Shared edits and template pushes are preview-then-commit: the
 * first call returns who it reaches and a confirm token, the second commits.
 */
import { createHash } from 'crypto';
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
import type { ManagedPartContent, ManagedPartKind, ManagedTemplateSettings } from '../../../../shared/managed-agents-types';
import type { Project } from '../../../../shared/types';

const ACTOR = 'Dispatcher';
const KINDS: ManagedPartKind[] = ['block', 'skill', 'mcp'];

function json(value: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}
function fail(text: string): McpToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

class ArgError extends Error {}

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

/** Binds a confirmation to exactly what was previewed. */
function token(...parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

type Handler = (callerId: string, args: Record<string, unknown>) => Promise<McpToolResult>;

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[], handler: Handler): void {
  registerGlobalTool(name, { description, inputSchema: { type: 'object', properties, required } }, async (callerId, args) => {
    try {
      // Every write here is attributed to the calling Dispatcher (#2900).
      return await withDispatcherCatalogWrites(callerId, () => handler(callerId, args));
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
    'List the agent part library: instruction blocks, skills or MCP servers. Each part says whether it is built in, a short preview, and which agents and templates use it. Parts are used by reference: an edit reaches every agent using it at its next start.',
    { kind: { ...S, description: 'block, skill or mcp' } }, ['kind'],
    async (_c, args) => json(await svc().listParts(kindArg(args))));

  tool('get_agent_part', 'Read one agent part with its full content and revision.',
    { id: S }, ['id'],
    async (_c, args) => json(await svc().getPart(requireString(args, 'id'))));

  tool('create_agent_part',
    'Create a custom agent part in the library. It is not added to any agent; use set_agent_setup for that. content: block {content}, skill {skillName, files: [{path, content, encoding?, executable?}]}, mcp {serverKey, transport: stdio|http|sse, command?, args?, url?, envVars?: names only}. Never put secret values in parts.',
    { kind: S, name: S, description: S, content: OBJ }, ['kind', 'name', 'content'],
    async (_c, args) => {
      const kind = kindArg(args);
      const content = contentArg(args, kind);
      if (!content || content.kind !== kind) throw new ArgError('content must match kind');
      return json(await svc().createPart({ name: requireString(args, 'name'), description: optionalString(args, 'description'), content, actor: ACTOR }));
    });

  tool('update_agent_part',
    'Edit or rename a custom part for every agent that uses it. Built-ins are read-only: fork them. Call once without confirm to see the agents it reaches and get a confirm token, then again with confirm to save. Running agents keep their current setup until restarted.',
    { id: S, expectedRevision: { type: 'number' }, name: S, description: S, content: OBJ, confirm: S }, ['id', 'expectedRevision'],
    async (_c, args) => {
      const id = requireString(args, 'id');
      const expectedRevision = numberArg(args, 'expectedRevision');
      const content = contentArg(args);
      const name = optionalString(args, 'name');
      const description = optionalString(args, 'description');
      const consumers = await svc().consumers(id);
      const expected = token(id, expectedRevision, content ?? null, name ?? null, description ?? null, consumers.map((c) => c.agentId).sort());
      const given = optionalString(args, 'confirm');
      if (consumers.length > 1 && given !== expected) {
        return json({ status: 'needs_confirmation', confirm: expected, reaches: consumers.map((c) => ({ agent: c.agentName, project: c.projectName, running: c.running })),
          note: 'Call again with this confirm token to save. Each agent gets the change at its next start; running ones keep their setup until restarted.' });
      }
      return json(await svc().updatePart({ id, expectedRevision, name, description, content, actor: ACTOR }));
    });

  tool('fork_agent_part',
    'Make a custom copy of a part in the library (forking a built-in is how to change one). With project and agent, that agent switches to the copy and the others keep the original.',
    { id: S, project: PROJECT, agent: AGENT, name: S }, ['id'],
    async (_c, args) => {
      const id = requireString(args, 'id');
      const target = args.agent !== undefined ? await resolveAgent(args) : null;
      return json(await svc().forkPart({ id, ...(target && { agent: { projectPath: target.project.path, agentId: target.agentId } }), name: optionalString(args, 'name'), actor: ACTOR }));
    });

  tool('delete_agent_part',
    'Delete a custom part. mode "copy" gives each agent that uses it its own copy; "remove" takes it out of those agents. Templates drop it either way.',
    { id: S, expectedRevision: { type: 'number' }, mode: { ...S, description: 'copy or remove' } }, ['id', 'expectedRevision', 'mode'],
    async (_c, args) => {
      const mode = requireString(args, 'mode');
      if (mode !== 'copy' && mode !== 'remove') throw new ArgError('mode must be copy or remove');
      await svc().deletePart({ id: requireString(args, 'id'), expectedRevision: numberArg(args, 'expectedRevision'), mode });
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
    'Replace a managed agent\'s parts: blocks in the order it reads them, skills and MCP servers. Applies at its next start; use restart_agent for a running one.',
    { project: PROJECT, agent: AGENT, blocks: IDS, skills: IDS, mcps: IDS }, ['project', 'agent', 'blocks', 'skills', 'mcps'],
    async (_c, args) => {
      const t = await resolveAgent(args);
      const current = await svc().getSetup(t.project.path, t.agentId);
      if (!current) throw new ArgError(`${t.agentName} isn't Clubhouse managed.`);
      return json(await svc().saveSetup(t.project.path, t.agentId, { ...current, blocks: idList(args, 'blocks'), skills: idList(args, 'skills'), mcps: idList(args, 'mcps') }));
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

  tool('list_agent_templates', 'List templates (built-in and custom) with their parts, settings and how many agents were made from each.',
    {}, [],
    async () => json(await svc().listTemplates()));

  tool('save_agent_template',
    'Create a custom template, or edit one by id. Editing changes future agents only; use push_agent_template to apply it to agents made from it. settings: orchestrator, model, freeAgentMode, orchestration {...}.',
    { id: S, name: S, description: S, blocks: IDS, skills: IDS, mcps: IDS, settings: OBJ }, ['name'],
    async (_c, args) => json(await svc().saveTemplate({
      ...(optionalString(args, 'id') && { id: optionalString(args, 'id') }),
      name: requireString(args, 'name'), description: optionalString(args, 'description') ?? '',
      setup: { blocks: idList(args, 'blocks'), skills: idList(args, 'skills'), mcps: idList(args, 'mcps') },
      settings: objectArg<ManagedTemplateSettings>(args, 'settings') ?? {},
    })));

  tool('push_agent_template',
    'Save a template edit and apply its changes to agents made from it. Call once without confirm to see the changes and agents with how many changes apply to each, then again with confirm and the agent ids to apply to.',
    { id: S, blocks: IDS, skills: IDS, mcps: IDS, settings: OBJ, agents: IDS, confirm: S }, ['id', 'blocks', 'skills', 'mcps'],
    async (_c, args) => {
      const id = requireString(args, 'id');
      const next = { setup: { blocks: idList(args, 'blocks'), skills: idList(args, 'skills'), mcps: idList(args, 'mcps') }, settings: objectArg<ManagedTemplateSettings>(args, 'settings') ?? {} };
      const preview = await svc().previewTemplatePush(id, next);
      const chosen = idList(args, 'agents');
      const expected = token(id, next, chosen.slice().sort());
      if (optionalString(args, 'confirm') !== expected) {
        return json({ status: 'needs_confirmation', confirm: expected, changes: preview.changes, agents: preview.targets,
          note: 'Call again with the same arguments, the agent ids to apply to in agents, and this confirm token.' });
      }
      const targets = preview.targets.filter((t) => chosen.includes(t.agentId)).map((t) => ({ projectPath: t.projectPath, agentId: t.agentId }));
      const results = await svc().pushTemplate(id, next, targets);
      const failed: Array<{ agentId: string; message: string }> = [];
      for (const r of results) {
        if (r.failed) { failed.push({ agentId: r.agentId, message: r.failed }); continue; }
        await applyManagedSettings(r.projectPath, r.agentId, r.settings).catch((err) => failed.push({ agentId: r.agentId, message: err instanceof Error ? err.message : String(err) }));
      }
      return json({ status: 'pushed', applied: targets.length - failed.length, failed });
    });

  tool('create_managed_agent',
    'Create a Clubhouse-managed durable agent, from a template or a full setup. It gets its own worktree (or folder) and is created asleep; wake it with wake_agent.',
    { project: PROJECT, name: S, color: S, templateId: S, blocks: IDS, skills: IDS, mcps: IDS, settings: OBJ }, ['project', 'name'],
    async (_c, args) => {
      const project = await resolveProject(requireString(args, 'project'));
      const hasSetup = ['blocks', 'skills', 'mcps'].some((k) => args[k] !== undefined);
      const config = await createManagedAgent(project.path, {
        name: requireString(args, 'name'),
        color: optionalString(args, 'color') ?? 'indigo',
        templateId: optionalString(args, 'templateId'),
        ...(hasSetup && { setup: { blocks: idList(args, 'blocks'), skills: idList(args, 'skills'), mcps: idList(args, 'mcps') } }),
        settings: objectArg<ManagedTemplateSettings>(args, 'settings'),
      });
      return json({ id: config.id, name: config.name, project: project.name, status: 'sleeping' });
    });

  tool('restart_agent',
    'Restart a running managed agent so it picks up its setup. It resumes the same conversation unless fresh is true, or the CLI changed. With whenTurnEnds, waits for its current turn first.',
    { project: PROJECT, agent: AGENT, fresh: { type: 'boolean' }, whenTurnEnds: { type: 'boolean' } }, ['project', 'agent'],
    async (_c, args) => {
      const t = await resolveAgent(args);
      const result = await restartManagedAgent(t.project.path, t.agentId, { fresh: optionalBoolean(args, 'fresh'), whenTurnEnds: optionalBoolean(args, 'whenTurnEnds') });
      return json({ status: 'restarted', resumed: result.resumed });
    });
}
