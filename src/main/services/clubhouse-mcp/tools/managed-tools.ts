/**
 * Builder tools (#2900), in the `dispatcher` tool group: every builder
 * action as a Clubhouse MCP tool, so the
 * (list_agent_templates and list_agent_parts are also an orchestrator's, #3001)
 * Dispatcher can manage agent parts, templates and managed agents for the
 * person. They call the same service the UI does. Shared edits, deleting a
 * part in use and template pushes are preview-then-commit: the first call
 * returns who it reaches and a confirm token, the second commits with it.
 * delete_agent (#3182) deletes an agent with its helpers: every choice is an
 * argument and nothing opens a dialog; its grant asks first by default.
 */
import { legacyDefaultsNotCopied } from '../../legacy-defaults';
import { createHash, randomBytes } from 'crypto';
import * as path from 'path';
import { callGrantIsApproved, grantApprovalContext, registerGlobalTool } from '../tool-registry';
import type { McpToolResult } from '../types';
import type { ToolGrant, ToolGrantDeclaration } from '../tool-grants';
import { appLog } from '../../log-service';
import * as projectStore from '../../project-store';
import * as agentConfig from '../../agent-config';
import { withDispatcherCatalogWrites } from '../../asset-catalog/store';
import { activationFor, managedAgents, restartManagedAgent, statusFor } from '../../managed-agents';
import { applyManagedSettings, createManagedAgent } from '../../managed-agents/agents';
import { previewManagedSetup } from '../../managed-agents/delivery';
import { discoverManagedAssets } from '../../managed-agents/discovery';
import { prepareManagedAssetImport, type ManagedAssetImportRequest } from '../../managed-agents/imports';
import { checkTemplateSettings, ManagedError, ManagedPartCreationError } from '../../managed-agents/service';
import { withAgentActivity } from '../../agent-transition';
import { resolveOrchestrator } from '../../agent-system';
import { getDefaultAccess, getPermissionMode } from '../../free-agent-settings';
import { callerAccess, withAccess, type AccessLevel } from '../../../../shared/agent-access';
import { accessCeilingRefusal } from '../access-ceiling';
import { isDispatcherAgent } from '../dispatcher-gate';
import { isCrossProjectEnabled } from '../orchestration-gate';
import { optionalBoolean, optionalString, requireString } from './validation';
import { CLUBHOUSE_MCP_PART_ID, CLUBHOUSE_PART_ALWAYS_ON, isListed, type ManagedPartContent, type ManagedPartKind, type ManagedTemplateSettings } from '../../../../shared/managed-agents-types';
import type { Project } from '../../../../shared/types';
import { agentRegistry } from '../../agent-registry';
import { capToHolder, checkToolGrant } from '../grant-check';
import { describeCallsForAsk } from '../ask-first';
import { resolveArgTargets } from '../arg-targets';
import { isDisposedAgent } from '../../../../shared/agent-helpers';
import { deleteAgent } from '../../agent-delete';
import type { AgentDeleteResult, HelperDeleteChoice } from '../../../../shared/types';
import { createDispatcherManagedAgent } from '../dispatcher-bootstrap';

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

/** A refused stale edit: what the part is now, so the caller can read it and decide (D92). */
function staleText(part: { name: string; revision: number; updatedAt: string; updatedBy?: string }): string {
  const by = part.updatedBy ? ` by ${part.updatedBy}` : '';
  return `${part.name} changed since you read it. It is at revision ${part.revision} now, saved${by} at ${part.updatedAt}. Read it with get_agent_part, then call again with expectedRevision ${part.revision} (and its name and description as expectedName and expectedDescription) if your change should still go in.`;
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

/**
 * Template settings from a call. Clubhouse permissions aren't taken (#2971):
 * only the user sets what agents made from a template may do, so an agent
 * can't grant through a template more than it holds. A template's saved
 * permissions are kept through an edit that replaces its other settings.
 */
function settingsArg(args: Record<string, unknown>, keep?: ManagedTemplateSettings): ManagedTemplateSettings | undefined {
  const settings = objectArg<ManagedTemplateSettings>(args, 'settings');
  if (settings && 'grants' in settings) throw new ArgError('settings.grants: only the user sets a template\'s Clubhouse permissions, in Settings. Leave it out.');
  if (settings?.orchestration !== undefined && (!settings.orchestration || typeof settings.orchestration !== 'object' || Array.isArray(settings.orchestration))) {
    throw new ArgError('settings.orchestration must be an object.');
  }
  if (settings?.orchestration && 'connectToDispatcher' in settings.orchestration) {
    throw new ArgError('settings.orchestration.connectToDispatcher is not accepted. When creating an agent, use the top-level connectToDispatcher option, which has its own permission. Only the user changes existing connections.');
  }
  if (!settings) return undefined;
  return keep?.grants?.length ? { ...settings, grants: keep.grants } : settings;
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
  // As the grant check resolves it (arg-targets.ts): a disposed helper's row is no agent to act on.
  const agents = (await agentConfig.listDurable(project.path)).filter((a) => !isDisposedAgent(a));
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

/**
 * Builder reads an orchestrator also gets (#3001): the templates and parts start_helper can
 * name when the person lets orchestrators choose helper templates. Every other builder tool
 * is the Dispatcher's.
 */
const ORCHESTRATOR_READS = new Set(['list_agent_templates', 'list_agent_parts']);

/**
 * An orchestrator's read of the library (#3001): only while the person lets orchestrators
 * choose helper templates, which is what it is for, and showing only the agents in its own
 * project unless cross-project helpers is on. The Dispatcher sees everything.
 */
async function orchestratorScope(callerId: string): Promise<((projectPath: string) => boolean) | null> {
  if (isDispatcherAgent(callerId)) return null;
  if (!(await managedAgents().helperTemplateChoice())) {
    throw new ArgError('Orchestrators read the part library and templates only when the person lets them choose helper templates (Settings, Managed agents, Helpers). start_helper uses the default helper template.');
  }
  if (isCrossProjectEnabled(callerId)) return null;
  const own = agentRegistry.get(callerId)?.projectPath;
  return (projectPath) => !!own && projectPath === own;
}

function tool(name: string, grant: ToolGrant, description: string, properties: Record<string, unknown>, required: string[], handler: Handler): void {
  registerGlobalTool(name, { description, inputSchema: { type: 'object', properties, required } }, async (callerId, args) => {
    try {
      // Writes run under asDispatcher, which attributes them to the calling Dispatcher (#2900).
      return await handler(callerId, args);
    } catch (err) {
      // telemetry-exempt: the error reaches the Dispatcher as the tool result
      if (err instanceof ArgError) return fail(err.message);
      if (err instanceof ManagedPartCreationError) return { ...json({ status: 'partial', receipt: err.receipt, message: err.message, assigned: false, providerLoaded: 'not_confirmed' }), isError: true };
      if (err instanceof ManagedError) return fail(`${err.code}: ${err.message}`);
      appLog('core:mcp', 'warn', `${name} failed`, { meta: { callerId, error: err instanceof Error ? err.message : String(err) } });
      return fail(err instanceof Error ? err.message : String(err));
    }
  }, { group: ORCHESTRATOR_READS.has(name) ? ['dispatcher', 'orchestration'] : 'dispatcher', grant });
}

const DELETE_GRANT: ToolGrant = { actions: ['agent.dispose'], target: 'agent_arg', from: { args: ['agent'], project: 'project' } };
const CREATE_GRANTS: readonly ToolGrantDeclaration[] = [
  { actions: ['agent.create'], target: 'project_arg', from: { args: ['project'] } },
  { actions: ['agent.grant'], target: 'project_arg', ifArgs: ['settings', 'templateId'], from: { args: ['project'] } },
  { actions: ['connection.bootstrap'], target: 'created_by_me', ifTrue: ['connectToDispatcher'] },
];
const IMPORT_GRANTS: readonly ToolGrantDeclaration[] = [
  { actions: ['agent.read'], target: 'agent_arg', from: { args: ['agent'], project: 'project' } },
  { actions: ['library.read', 'library.write'], target: 'library' },
];
const RESTART_GRANTS: readonly ToolGrantDeclaration[] = [
  { actions: ['agent.restart'], target: 'agent_arg', from: { args: ['agent'], project: 'project' } },
  { actions: ['agent.sleep'], target: 'agent_arg', ifTrue: ['now'], from: { args: ['agent'], project: 'project' } },
];
const HELPER_CHOICES = ['dispose', 'keep'] as const;
const WORKTREE_CHOICES = ['delete', 'keep'] as const;

/** The line above a delete_agent call's arguments in Needs you: the agent and what happens to its helpers and worktree. */
export function describeDeleteCall(args: Record<string, unknown>): string {
  const agent = typeof args.agent === 'string' ? args.agent : 'an agent';
  const project = typeof args.project === 'string' ? ` in ${args.project}` : '';
  const force = args.force === true;
  const worktree = args.worktree === 'keep'
    ? 'Its files stay on disk.'
    : `Its worktree and branch are removed${force ? ', even with uncommitted or unpushed work' : ', unless it has uncommitted or unpushed work'}.`;
  const helpers = args.helpers === 'dispose'
    ? `Its helpers, and theirs, are disposed with their worktrees and branches${force ? ', even with uncommitted or unpushed work' : ', unless any has uncommitted or unpushed work'}.`
    : args.helpers === 'keep' ? 'Its helpers stay as ordinary agents.' : 'If it has helpers, nothing is deleted.';
  return `Delete ${agent}${project}. It is stopped if it is running, and so are quick agents running in its worktree. ${worktree} ${helpers}`;
}

function deletedFacts(name: string, worktree: string, result: AgentDeleteResult): Record<string, unknown> {
  return {
    status: 'deleted',
    agent: name,
    worktree: worktree === 'keep' ? 'kept on disk' : 'removed',
    ...(result.helpers && { helpers: { message: result.helpers.message, ids: result.helpers.helperIds ?? [] } }),
    ...(result.stoppedQuickAgents && { stoppedQuickAgents: result.stoppedQuickAgents }),
    message: result.message,
  };
}

/** A refusal with what stopped it, for the caller to act on or take to the user. */
function refusalFacts(name: string, result: AgentDeleteResult): Record<string, unknown> {
  const facts: Record<string, unknown> = { status: 'refused', agent: name, message: result.message };
  if (result.needsHelperChoice) {
    facts.helpers = result.needsHelperChoice.helpers;
    facts.next = 'Call again with helpers: dispose or keep.';
  }
  if (result.helpers) {
    if (result.helpers.blocked?.length) {
      facts.blockedHelpers = result.helpers.blocked.map((b) => ({ id: b.agentId, name: b.name, ...b.checks }));
      facts.next = result.helpers.blocked.some((b) => b.checks.error)
        ? 'A helper couldn\'t be checked, which force doesn\'t override. Ask the user, or keep the helpers.'
        : 'Ask the user, save the helpers\' work, keep the helpers, or call again with force: true.';
    }
    if (result.helpers.failed?.length) {
      facts.disposedHelpers = result.helpers.helperIds ?? [];
      facts.failedHelpers = result.helpers.failed;
    }
  }
  if (result.worktree) {
    const w = result.worktree;
    facts.worktree = {
      branch: w.branch,
      uncommittedFiles: w.uncommittedFiles.length,
      unpushedCommits: w.unpushedCommits.length,
      ...(w.checkError && { checkError: w.checkError }),
    };
    facts.next = w.checkError
      ? 'Its worktree couldn\'t be checked, which force doesn\'t override. Call again with worktree: keep to leave its files on disk, or ask the user.'
      : 'Ask the user, call again with worktree: keep to leave its files on disk, or with force: true to lose the work.';
  }
  return facts;
}

const S = { type: 'string' } as const;
const IDS = { type: 'array', items: { type: 'string' } } as const;
const OBJ = { type: 'object' } as const;
const PROJECT = { type: 'string', description: 'Project name or path, from list_projects.' } as const;
const AGENT = { type: 'string', description: 'Agent id or name, from list_agents.' } as const;

export function registerManagedTools(): void {
  const svc = () => managedAgents();

  tool('list_agent_parts', { actions: ['library.read'], target: 'library' },
    'List the agent part library: instruction blocks, skills or MCP servers. Each part says whether it is built in, a short preview, and which agents and templates use it. Parts are used by reference: an edit reaches every agent using it at its next start. Retired built-ins are left out; agents that use one still get it, and get_agent_part reads it. source "builtin" or "custom" lists only those, as the library\'s source filter does.',
    { kind: { ...S, description: 'block, skill or mcp' }, source: { ...S, description: 'Optional: builtin or custom. Leave out for both.' } }, ['kind'],
    async (callerId, args) => {
      const kind = kindArg(args);
      const source = optionalString(args, 'source');
      if (source !== undefined && source !== 'builtin' && source !== 'custom') throw new ArgError('source must be builtin or custom');
      const inScope = await orchestratorScope(callerId);
      const parts = (await svc().listParts(kind)).filter(isListed)
        .map((p) => (inScope ? { ...p, usedBy: p.usedBy.filter((u) => inScope(u.projectPath)) } : p));
      return json(source === undefined ? parts : parts.filter((p) => p.builtin === (source === 'builtin')));
    });

  tool('get_agent_part', { actions: ['library.read'], target: 'library' }, 'Read one agent part with its full content and revision.',
    { id: S }, ['id'],
    async (_c, args) => json(await svc().getPart(requireString(args, 'id'))));

  tool('discover_agent_assets', { actions: ['agent.read'], target: 'agent_arg', from: { args: ['agent'], project: 'project' } },
    'Discover skill folders and local MCP definitions in a registered agent\'s effective-provider folder, without executing anything or changing files. Plain agents remain plain. Only this agent folder is inspected, not global/inherited configuration. Discovered does not mean configured, desired, running or provider-confirmed loaded. Use import_agent_asset to preview a complete bundle.',
    { project: PROJECT, agent: AGENT }, ['project', 'agent'],
    async (_c, args) => {
      const t = await resolveAgent(args);
      const agent = await agentConfig.getDurableConfig(t.project.path, t.agentId);
      if (!agent?.worktreePath) throw new ArgError('This agent has no own source folder. Import accepts only a registered agent folder, never an arbitrary path.');
      const provider = await resolveOrchestrator(t.project.path, agent.orchestrator);
      return json({ agentId: t.agentId, provider: provider.id, ...await discoverManagedAssets({ root: agent.worktreePath, conventions: provider.conventions }) });
    });

  tool('import_agent_asset', IMPORT_GRANTS,
    'Preview, then explicitly confirm importing one discovered asset into the shared part library. project/agent name the source, not a target to change. candidateId comes from discover_agent_assets. mode copy requires name and makes an independent bundle; reuse requires an exactly matching partId and follows that shared part. No assignment, conversion, restart or probe. Supporting/binary files and executable flags are kept; links, unsafe paths, credentials and unsupported fields refuse the whole import. Preview returns no content or source paths. Confirm with identical arguments and the single-use token; source/library changes require a new preview.',
    { project: PROJECT, agent: AGENT, candidateId: S, mode: { type: 'string', enum: ['copy', 'reuse'] }, partId: S, name: S, confirm: S },
    ['project', 'agent', 'candidateId', 'mode'],
    async (callerId, args) => {
      const t = await resolveAgent(args);
      let projectChanged = false;
      const releaseProject = projectStore.onProjectsChanged(() => { projectChanged = true; });
      try {
        const agent = await agentConfig.getDurableConfig(t.project.path, t.agentId);
        if (!agent?.worktreePath) throw new ArgError('The source agent has no own folder.');
        const provider = await resolveOrchestrator(t.project.path, agent.orchestrator);
        const mode = requireString(args, 'mode');
        if (mode !== 'copy' && mode !== 'reuse') throw new ArgError('mode must be copy or reuse.');
        const request: ManagedAssetImportRequest = { candidateId: requireString(args, 'candidateId'), mode,
          partId: optionalString(args, 'partId'), name: optionalString(args, 'name') };
        const source = { root: agent.worktreePath, conventions: provider.conventions };
        const sourceOrchestrator = agent.orchestrator;
        const plan = await prepareManagedAssetImport(svc(), source, request, t.project.id);
        const digest = digestOf('import_agent_asset', t.project.id, t.agentId, provider.id, plan.fingerprint);
        const confirm = optionalString(args, 'confirm');
        if (!confirm) return json({ status: 'needs_confirmation', confirm: issueConfirm(callerId, digest), ...plan.preview });
        redeemConfirm(callerId, confirm, digest);
        const part = await withAgentActivity(t.agentId, () => asDispatcher(callerId, () => plan.commit(ACTOR, async (assertSnapshot) => {
          const stableArgs = { ...args, project: t.project.path, agent: t.agentId };
          const targets = await resolveArgTargets(callerId, IMPORT_GRANTS, stableArgs);
          await assertSnapshot();
          const current = await resolveAgent(stableArgs);
          const currentAgent = await agentConfig.getDurableConfig(current.project.path, current.agentId);
          const currentProvider = await resolveOrchestrator(current.project.path, currentAgent?.orchestrator);
          return () => {
            if (projectChanged || current.project.id !== t.project.id || currentAgent?.worktreePath !== source.root || currentAgent?.orchestrator !== sourceOrchestrator
              || currentProvider.id !== provider.id || digestOf(currentProvider.conventions) !== digestOf(source.conventions)) {
              throw new ManagedError('stale', 'The registered project, source folder or provider changed before import committed. Preview again; nothing was imported.');
            }
            if (!targets.get(IMPORT_GRANTS[0])?.length) throw new ManagedError('not_permitted', 'The source authorization target is no longer available. Preview again; nothing was imported.');
            const check = checkToolGrant(callerId, IMPORT_GRANTS, stableArgs, undefined, targets);
            const context = grantApprovalContext(callerId, 'import_agent_asset', args, IMPORT_GRANTS, targets);
            if (!callGrantIsApproved(callerId, 'import_agent_asset', args, check, context)) {
              throw new ManagedError('not_permitted', 'Import authorization changed before the library write. Nothing was imported; request permission and preview again.');
            }
          };
        })));
        return json({ status: mode === 'copy' ? 'imported' : 'reused', part, assigned: false, providerLoaded: 'not_confirmed' });
      } finally { releaseProject(); }
    });

  tool('create_agent_part', { actions: ['library.write'], target: 'library' },
    'Create a custom agent part in the library. It is not added to any agent; use set_agent_setup for that. content: block {content}, skill {skillName, files: [{path, content, encoding?, executable?}]}, mcp {serverKey, transport: stdio|http|sse, command?, args?, url?, envVars?: names only}. Never put secret values in parts.',
    { kind: S, name: S, description: S, content: OBJ }, ['kind', 'name', 'content'],
    async (callerId, args) => {
      const kind = kindArg(args);
      const content = contentArg(args, kind);
      if (!content || content.kind !== kind) throw new ArgError('content must match kind');
      const input = { name: requireString(args, 'name'), description: optionalString(args, 'description'), content, actor: ACTOR };
      return json(await asDispatcher(callerId, () => svc().createPart(input)));
    });

  tool('update_agent_part', { actions: ['library.write'], target: 'library' },
    'Edit or rename a custom part for every agent that uses it. Built-ins are read-only: fork them. A rename needs expectedName and a description edit needs expectedDescription: the name and description you read with get_agent_part, since neither changes the revision. When more than one agent uses it, the first call returns the agents and templates it reaches and a confirm token; call again with the same arguments and confirm to save. A token is yours only, works once, and expires after 10 minutes. Running agents keep their current setup until restarted.',
    { id: S, expectedRevision: { type: 'number' }, expectedName: S, expectedDescription: S, name: S, description: S, content: OBJ, confirm: S }, ['id', 'expectedRevision'],
    async (callerId, args) => {
      const id = requireString(args, 'id');
      const expectedRevision = numberArg(args, 'expectedRevision');
      const content = contentArg(args);
      const name = optionalString(args, 'name');
      const description = optionalString(args, 'description');
      // The same rule as the editor: a rename or description edit says what it read (D92).
      const expectedName = typeof args.expectedName === 'string' ? args.expectedName : undefined;
      const expectedDescription = typeof args.expectedDescription === 'string' ? args.expectedDescription : undefined;
      if (name !== undefined && expectedName === undefined) throw new ArgError('A rename needs expectedName: the name you read with get_agent_part.');
      if (description !== undefined && expectedDescription === undefined) throw new ArgError('A description edit needs expectedDescription: the description you read with get_agent_part (empty for none).');
      const part = await svc().getPart(id);
      if (part.builtin) throw new ManagedError('builtin_read_only', 'Built-in parts can\'t be edited. Fork it with fork_agent_part instead.');
      // Never saved over a newer version: say what is there now, so the caller can read it and decide.
      if (part.revision !== expectedRevision
        || (expectedName !== undefined && expectedName.trim() !== part.name)
        || (expectedDescription !== undefined && expectedDescription.trim() !== part.description)) {
        throw new ManagedError('stale', staleText(part));
      }
      // The name and description are in the digest too, so a rename between preview and confirm refuses the token.
      const digest = digestOf('update_agent_part', id, part.revision, part.name, part.description, part.content, expectedRevision, content ?? null, name ?? null, description ?? null,
        part.usedBy.map((c) => c.agentId).sort(), part.templates.map((t) => t.id).sort());
      const given = optionalString(args, 'confirm');
      if (given) redeemConfirm(callerId, given, digest);
      // The UI's rule (needsImpactDialog, D93): agents and templates together, so a template's future agents count (#3100).
      else if (part.usedBy.length + part.templates.length > 1) {
        return json({ status: 'needs_confirmation', confirm: issueConfirm(callerId, digest),
          reaches: part.usedBy.map((c) => ({ agent: c.agentName, project: c.projectName, running: c.running })),
          templates: part.templates.map((t) => t.name),
          note: 'Call again with the same arguments and this confirm token to save. Each agent gets the change at its next start; running ones keep their setup until restarted. Agents made from these templates later get it too.' });
      }
      return json(await asDispatcher(callerId, () => svc().updatePart({ id, expectedRevision, expectedName, expectedDescription, name, description, content, actor: ACTOR })));
    });

  tool('fork_agent_part', [{ actions: ['library.write'], target: 'library' }, { actions: ['agent.grant'], target: 'agent_arg', ifArgs: ['agent'], from: { args: ['agent'], project: 'project' } }],
    'Make a custom copy of a part in the library (forking a built-in is how to change one). With project and agent, that agent switches to the copy and the others keep the original.',
    { id: S, project: PROJECT, agent: AGENT, name: S }, ['id'],
    async (callerId, args) => {
      const id = requireString(args, 'id');
      const target = args.agent !== undefined ? await resolveAgent(args) : null;
      const input = { id, ...(target && { agent: { projectPath: target.project.path, agentId: target.agentId } }), name: optionalString(args, 'name'), actor: ACTOR };
      return json(await asDispatcher(callerId, () => svc().forkPart(input)));
    });

  tool('delete_agent_part', { actions: ['library.write'], target: 'library' },
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

  tool('get_agent_setup', { actions: ['agent.read'], target: 'agent_arg', from: { args: ['agent'], project: 'project' } },
    'Read what a managed agent is built from (block ids in order, skill ids, MCP ids, its template) and whether a running session is behind its setup.',
    { project: PROJECT, agent: AGENT }, ['project', 'agent'],
    async (_c, args) => {
      const t = await resolveAgent(args);
      return json({ setup: await svc().getSetup(t.project.path, t.agentId), status: await statusFor(t.project.path, t.agentId) });
    });

  tool('get_agent_activation', { actions: ['agent.read'], target: 'agent_arg', from: { args: ['agent'], project: 'project' } },
    'Read passive activation evidence and the latest restart receipt: configured references, desired revisions, recorded materialization and running launch setup are separate. Provider-confirmed loaded skills/tools remain not confirmed without trusted current-session evidence. Never treats file writes, session creation or MCP handshakes as verification; runs no paid probe. A pending/failed restart is not success and must not be blindly retried.',
    { project: PROJECT, agent: AGENT }, ['project', 'agent'],
    async (_c, args) => {
      const t = await resolveAgent(args);
      return json(await activationFor(t.project.path, t.agentId));
    });

  tool('set_agent_setup', { actions: ['agent.grant'], target: 'agent_arg', from: { args: ['agent'], project: 'project' } },
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

  tool('preview_agent_setup', { actions: ['agent.read'], target: 'agent_arg', from: { args: ['agent'], project: 'project' } },
    'The exact result a managed agent gets at its next start: instruction text with each block\'s lines, skills and where they go, MCP servers.',
    { project: PROJECT, agent: AGENT }, ['project', 'agent'],
    async (_c, args) => {
      const t = await resolveAgent(args);
      const agent = await agentConfig.getDurableConfig(t.project.path, t.agentId);
      if (!agent?.managed) throw new ArgError(`${t.agentName} isn't Clubhouse managed.`);
      const provider = await resolveOrchestrator(t.project.path, agent.orchestrator).catch((): undefined => undefined);
      return json(await previewManagedSetup({ service: svc(), projectPath: t.project.path, agent, provider }));
    });

  /**
   * Template settings as a caller sent them: a level it names wins over the legacy
   * flag it read back beside it, so lowering a level never comes out higher (#2997, D103).
   * A new template has no level yet for a bare legacy flag to keep.
   */
  const sentSettings = (settings: ManagedTemplateSettings, from: ManagedTemplateSettings | undefined): ManagedTemplateSettings => {
    // Refused as sent (an unknown level, a flag that isn't on/off), before anything reads them as a level.
    checkTemplateSettings(settings);
    return callerAccess(settings, from ? levelOf(from) : undefined, getPermissionMode());
  };
  const levelOf = (s: ManagedTemplateSettings | undefined): AccessLevel =>
    (s ? withAccess(s, getPermissionMode()).access : undefined) ?? getDefaultAccess();

  tool('list_agent_templates', { actions: ['library.read'], target: 'library' }, 'List templates (built-in and custom) with their parts, settings and how many agents were made from each. Retired built-in templates are left out; agents made from one keep working.',
    {}, [],
    async (callerId) => {
      await orchestratorScope(callerId);
      return json((await svc().listTemplates()).filter(isListed));
    });

  tool('save_agent_template', { actions: ['template.write'], target: 'library' },
    'Create a custom template (name required), or edit one by id. Editing an id keeps every field you leave out as saved; settings, when given, replaces the template\'s settings as a whole. Editing changes future agents only; use push_agent_template to apply it to agents made from it. settings: orchestrator, model, effort, access (plan, ask, auto_edit, auto or full_access), orchestration {...}, idleSleep (minutes or "never"), helperTemplateId. A legacy freeAgentMode beside access is ignored.',
    { id: S, name: S, description: S, blocks: IDS, skills: IDS, mcps: IDS, settings: OBJ }, [],
    async (callerId, args) => {
      const id = optionalString(args, 'id');
      if (!id) {
        const settings = settingsArg(args);
        const input = {
          name: requireString(args, 'name'), description: optionalString(args, 'description') ?? '',
          setup: { blocks: idList(args, 'blocks'), skills: idList(args, 'skills'), mcps: idList(args, 'mcps') },
          settings: settings ? sentSettings(settings, undefined) : {},
        };
        return json(keptClubhousePart(input.setup.mcps, await asDispatcher(callerId, () => svc().saveTemplate(input))));
      }
      // An edit merges what the call gave into the saved template.
      const current = await svc().getTemplate(id);
      const settings = settingsArg(args, current.settings);
      const input = {
        id,
        name: optionalString(args, 'name') ?? current.name,
        description: optionalString(args, 'description') ?? current.description,
        setup: {
          blocks: idListOr(args, 'blocks', current.setup.blocks),
          skills: idListOr(args, 'skills', current.setup.skills),
          mcps: idListOr(args, 'mcps', current.setup.mcps),
        },
        settings: settings ? sentSettings(settings, current.settings) : current.settings,
      };
      return json(keptClubhousePart(input.setup.mcps, await asDispatcher(callerId, () => svc().saveTemplate(input))));
    });

  tool('push_agent_template', [{ actions: ['template.write'], target: 'library' }, { actions: ['template.push'], target: 'agent_arg', ifArgs: ['agents'], from: { args: ['agents'] } }],
    'Save a template edit and apply its changes to agents made from it. Call once without confirm, naming in agents the agent ids to apply to: it returns the changes, every agent made from the template with how many changes apply to each, and a confirm token for that choice. Then call again with the same arguments and confirm. Settings left out stay as the template has them. A token is yours only, works once, expires after 10 minutes, and is refused if the template changed since the preview.',
    { id: S, blocks: IDS, skills: IDS, mcps: IDS, settings: OBJ, agents: IDS, confirm: S }, ['id', 'blocks', 'skills', 'mcps'],
    async (callerId, args) => {
      const id = requireString(args, 'id');
      const current = await svc().getTemplate(id);
      const sent = settingsArg(args, current.settings);
      const next = {
        setup: { blocks: idList(args, 'blocks'), skills: idList(args, 'skills'), mcps: idList(args, 'mcps') },
        settings: sent ? sentSettings(sent, current.settings) : current.settings,
      };
      // A push that changes the template's saved Access sets it on the agents it reaches: never above the
      // caller's own (D126). Dropping the level sends them to the Default access, even one equal to the old level.
      const before = withAccess(current.settings, getPermissionMode()).access;
      const sentLevel = withAccess(next.settings, getPermissionMode()).access;
      if (sentLevel !== before) {
        const refused = accessCeilingRefusal(callerId, sentLevel ?? getDefaultAccess(), 'push a template that sets agents',
          sentLevel ? {} : { from: 'Leaving the level out means the Default access for new agents, which' });
        if (refused) throw new ArgError(refused);
      }
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

  tool('delete_agent_template', { actions: ['template.write'], target: 'library' },
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

  describeCallsForAsk('create_managed_agent', (args) => `Create ${String(args.name)} in ${String(args.project)}.${args.connectToDispatcher === true ? ' Connect only that new agent to the Dispatcher controller in both directions. Each direction can read, message and wake, with clear and compact off. Existing user switches stay as they are.' : ''}`);
  tool('create_managed_agent', CREATE_GRANTS.map((g) => ({ ...g, askHandledByTool: true })),
    'Create a durable agent, asleep. connectToDispatcher: true asks for the separate connection.bootstrap permission on only this new agent, Ask first by default. Once connected, its generated wake_agent and send_message tools become available. Without it, ask the user to enable Connect to Dispatcher; an unconnected agent cannot be woken or messaged here. Both connection directions start with read, message and wake on, clear and compact off. Retrying the same connected creation in this app session returns its receipt, not another agent. By default it is Clubhouse managed, from a template or a full setup, in its own worktree (or folder). Explicit settings override the template field by field; omitted settings inherit it. The CLI is settings.orchestrator and its model is settings.model, not top-level arguments or settings.provider. With no CLI in either, the project CLI then the app default applies. managed: false makes a plain agent instead, in its own worktree, that reads its own files; it takes settings but no template or parts. settings.orchestration.connectToDispatcher is not accepted.',
    { project: PROJECT, name: S, color: S, connectToDispatcher: { type: 'boolean', description: 'Connect only the agent created by this call, with separate approval. Default false.' }, managed: { type: 'boolean', description: 'false for a plain (unmanaged) agent. Default true.' }, templateId: S, blocks: IDS, skills: IDS, mcps: IDS, settings: {
      type: 'object',
      description: 'Explicit settings override the template field by field. Confirm the CLI, model, access and orchestration with the user before creation.',
      properties: {
        orchestrator: { type: 'string', description: 'CLI id, for example copilot-cli, codex-cli or claude-code. Overrides the template CLI.' },
        model: { type: 'string', description: 'Model id for the chosen CLI, or "default" for its default model. Overrides the template model.' },
        effort: { type: ['string', 'null'] }, access: { type: 'string', enum: ['plan', 'ask', 'auto_edit', 'auto', 'full_access'] },
        freeAgentMode: { type: 'boolean', description: 'Legacy access toggle; prefer access.' },
        orchestration: OBJ, idleSleep: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'string', enum: ['never'] }, { type: 'null' }] },
        helperTemplateId: { type: ['string', 'null'] },
      },
    } }, ['project', 'name'],
    async (callerId, args) => {
      if (['provider', 'orchestrator', 'model'].some((key) => key in args)) {
        throw new ArgError('Set the CLI with settings.orchestrator and its model with settings.model, not top-level provider, orchestrator or model. Nothing was created.');
      }
      const settings = settingsArg(args);
      if (settings && 'provider' in settings) {
        throw new ArgError('settings.provider is not accepted. Use settings.orchestrator for the CLI and settings.model for its model. Nothing was created.');
      }
      // Validate without normalizing: callerAccess must still resolve legacy access against the template.
      checkTemplateSettings(settings);
      const project = await resolveProject(requireString(args, 'project'));
      const hasSetup = ['blocks', 'skills', 'mcps'].some((k) => args[k] !== undefined);
      const plain = optionalBoolean(args, 'managed') === false;
      if (plain && (hasSetup || args.templateId !== undefined)) throw new ArgError('A plain agent has no template or parts. Leave out templateId, blocks, skills and mcps, or leave out managed: false.');
      const input = {
        name: requireString(args, 'name'),
        color: optionalString(args, 'color') ?? 'indigo',
        deferDispatcherConnection: true as const,
        ...(plain && { managed: false as const }),
        templateId: optionalString(args, 'templateId'),
        ...(hasSetup && { setup: { blocks: idList(args, 'blocks'), skills: idList(args, 'skills'), mcps: idList(args, 'mcps') } }),
        settings,
      };
      // A template's Clubhouse permissions pass only as far as the caller holds them (#2971, fixed rule 2).
      if (input.templateId) {
        const template = await svc().getTemplate(input.templateId);
        if (template.settings.grants?.length) {
          const elsewhere = agentRegistry.get(callerId)?.projectPath !== project.path;
          input.settings = { ...(input.settings ?? {}), grants: capToHolder(callerId, template.settings.grants, { elsewhere }) };
        }
      }
      // No agent makes another with more Access than it runs at (D126).
      const checkAccess = (level: AccessLevel, from: 'settings' | 'template' | 'default') => {
        const refused = from === 'settings'
          ? accessCeilingRefusal(callerId, level, 'create an agent')
          : accessCeilingRefusal(callerId, level, 'create an agent', {
            from: from === 'template' ? 'The template' : 'The Default access for new agents',
            fix: 'Pass settings.access at or below your level, or ask the user to create it.',
          });
        if (refused) throw new ArgError(refused);
      };
      // Templates and orchestration defaults cannot implicitly bootstrap a connection.
      input.settings = { ...input.settings, orchestration: { ...input.settings?.orchestration, connectToDispatcher: false } };
      // A plain agent made here gets none of the project's legacy defaults (#3245): say so.
      const legacy = plain ? await legacyDefaultsNotCopied(project.path) : undefined;
      return createDispatcherManagedAgent(callerId, args, project, CREATE_GRANTS,
        () => asDispatcher(callerId, () => createManagedAgent(project.path, input, checkAccess)),
        legacy ? { legacyDefaults: legacy, note: 'This project has legacy agent defaults. They weren\'t copied into the new agent; the user can copy them from the project\'s settings.' } : {});
    });

  tool('restart_agent', RESTART_GRANTS,
    'Restart a running managed agent so it picks up its setup. By default it waits for the agent\'s current turn to end first; now: true restarts it at once, cutting the turn off, and separately requires agent.sleep permission. Authorization is checked again after waiting. It resumes the same conversation unless fresh is true, or the CLI changed. Only running managed agents, and never yourself: a sleeping agent gets its setup when it next starts (wake_agent). A persisted lifecycle receipt is available with get_agent_activation; restart completion is not provider-loaded proof.',
    { project: PROJECT, agent: AGENT, fresh: { type: 'boolean' }, now: { type: 'boolean', description: 'Restart at once instead of after the current turn.' } }, ['project', 'agent'],
    async (callerId, args) => {
      const t = await resolveAgent(args);
      if (t.agentId === callerId) throw new ArgError('You can\'t restart yourself.');
      const status = await statusFor(t.project.path, t.agentId);
      if (!status.managed) throw new ArgError(`${t.agentName} isn't Clubhouse managed. restart_agent only restarts managed agents.`);
      if (!status.running) throw new ArgError(`${t.agentName} isn't running. It gets its setup when it next starts; restart_agent never wakes an agent.`);
      const now = optionalBoolean(args, 'now') === true;
      // No catalog grant: a restart writes no parts, and the spawn must not inherit one.
      const restart = restartManagedAgent(t.project.path, t.agentId, {
        fresh: optionalBoolean(args, 'fresh'), whenTurnEnds: !now,
        authorize: async () => {
          const stableArgs = { ...args, project: t.project.path, agent: t.agentId };
          const targets = await resolveArgTargets(callerId, RESTART_GRANTS, stableArgs);
          return () => {
            const required = now ? RESTART_GRANTS : [RESTART_GRANTS[0]];
            if (required.some((declaration) => !targets.get(declaration)?.some((target) =>
              target.kind === 'agent' && target.agentId === t.agentId && target.projectPath
                && path.resolve(target.projectPath) === path.resolve(t.project.path)))) {
              throw new ManagedError('not_permitted', 'The restart authorization target is no longer available. Inspect the lifecycle receipt and current target state before retrying.');
            }
            const grant = checkToolGrant(callerId, RESTART_GRANTS, stableArgs, undefined, targets);
            const context = grantApprovalContext(callerId, 'restart_agent', args, RESTART_GRANTS, targets);
            if (!callGrantIsApproved(callerId, 'restart_agent', args, grant, context)) {
              throw new ManagedError('not_permitted', 'Restart authorization changed before a lifecycle effect. Inspect the lifecycle receipt and current target state before requesting permission and retrying.');
            }
          };
        },
      });
      const answer = (r: { resumed: boolean; noSession?: boolean }) => json({ status: 'restarted', resumed: r.resumed,
        ...(r.noSession && { note: 'There was no conversation to resume, so it started a new one.' }) });
      if (now) return answer(await restart);
      // Waiting for a turn can take long: answer after a short wait, and let the restart finish behind it.
      const done = await settleWithin(restart, RESTART_ANSWER_MS);
      if (done) return answer(done);
      restart.catch((err: unknown) => {
        // telemetry-exempt: the persisted lifecycle receipt exposes failure after the tool answered.
        appLog('core:mcp', 'warn', 'restart_agent: restart after the turn failed', { meta: { callerId, agentId: t.agentId, code: err instanceof ManagedError ? err.code : 'restart_failed' } });
      });
      return json({ status: 'waiting_for_turn_end', note: `${t.agentName} is mid-turn. It restarts when the turn ends, or not at all if it is still working after 30 minutes. Check the lifecycle outcome with get_agent_activation; waiting is not completion or activation proof.` });
    });

  describeCallsForAsk('delete_agent', describeDeleteCall);

  tool('delete_agent', DELETE_GRANT,
    'Delete a durable agent. Nothing is shown to the user to confirm: the call says what happens, and a refusal changes nothing and says why. '
      + 'helpers (needed when it has any, in any project): dispose removes their worktrees and branches, helpers of helpers too, and stops if any has uncommitted or unpushed work; keep makes them ordinary agents. '
      + 'worktree: delete removes its worktree and branch, and stops if it has uncommitted or unpushed work; keep only removes it from Clubhouse and leaves its files on disk. '
      + 'force: true goes ahead despite uncommitted or unpushed work in its worktree and its helpers\' worktrees; a check that couldn\'t run still stops it. Quick agents running in its worktree are stopped. Never yourself or the Dispatcher.',
    {
      project: PROJECT,
      agent: AGENT,
      helpers: { type: 'string', enum: [...HELPER_CHOICES], description: 'What happens to its helpers: dispose or keep. Needed when it has any.' },
      worktree: { type: 'string', enum: [...WORKTREE_CHOICES], description: 'delete: remove its worktree and branch. keep: leave its files on disk.' },
      force: { type: 'boolean', description: 'Delete despite uncommitted or unpushed work. Default false.' },
    },
    ['project', 'agent', 'worktree'],
    async (callerId, args) => {
      const helpers = optionalString(args, 'helpers');
      if (helpers !== undefined && !(HELPER_CHOICES as readonly string[]).includes(helpers)) throw new ArgError(`helpers must be one of ${HELPER_CHOICES.join(', ')}`);
      const worktree = requireString(args, 'worktree');
      if (!(WORKTREE_CHOICES as readonly string[]).includes(worktree)) throw new ArgError(`worktree must be one of ${WORKTREE_CHOICES.join(', ')}`);
      const force = optionalBoolean(args, 'force') === true;
      const t = await resolveAgent(args);
      if (t.agentId === callerId) throw new ArgError('You can\'t delete yourself.');
      // Only an agent the grant check saw: it resolves the same arguments, and a name it couldn't place got no check.
      const [checked] = [...(await resolveArgTargets(callerId, DELETE_GRANT, args)).values()];
      if (!checked?.some((target) => !!target.projectPath && path.resolve(target.projectPath) === path.resolve(t.project.path))) {
        throw new ArgError(`No agent "${requireString(args, 'agent')}" in ${t.project.name}.`);
      }
      // Windows drop the deleted agent and disposed helpers on the agents.json change (syncDurableMembership).
      const result = await deleteAgent(t.project.path, t.agentId, {
        mode: worktree === 'keep' ? 'unregister' : 'force',
        helpers: helpers as HelperDeleteChoice | undefined,
        forceHelpers: force,
        checkWorktree: true,
        forceWorktree: force,
      });
      appLog('core:mcp', 'info', result.ok ? 'delete_agent deleted an agent' : 'delete_agent refused', {
        meta: { callerId, agentId: t.agentId, worktree, helpers, force, ok: result.ok },
      });
      return result.ok ? json(deletedFacts(t.agentName, worktree, result)) : { ...json(refusalFacts(t.agentName, result)), isError: true };
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
