/**
 * Targets named in a call's arguments (#2974, part of #2921): the agents and
 * projects an `agent_arg` or `project_arg` declaration reaches, resolved
 * before the grant check so it decides these calls too. Each declaration says
 * which arguments name its target (`from`).
 *
 * Only call time resolves them: a listing passes no arguments. A reference
 * that doesn't resolve (an unknown id, a name it can't place) is left to the
 * tool, which says it wasn't found, so a refusal never says whether a target
 * exists. The one exception is `project.add` (#3050), whose folder isn't a
 * project yet: it is checked by its path instead.
 */

import * as path from 'path';
import type { GrantCallTarget } from '../../../shared/agent-grants';
import type { DurableAgentConfig } from '../../../shared/types';
import { isDisposedAgent } from '../../../shared/agent-helpers';
import * as agentConfig from '../agent-config';
import { agentRegistry } from '../agent-registry';
import { resolveOrchestrationPolicies } from '../orchestration-policy';
import * as projectStore from '../project-store';
import { groupProjectRegistry } from '../group-project-registry';
import { parseAgentAddress } from '../../../shared/agent-address';
import { localConnectionWakeOn } from '../connection-grants-store';
import { bindingManager } from './binding-manager';
import { isDispatcherAgent, isTrackedDispatcher, isDispatcherCoordinatorId } from './dispatcher-gate';
import { mcpCallerKind, mcpCallerParent } from './mcp-call-gate';
import { toolGrantDeclarations, type ToolGrant, type ToolGrantDeclaration } from './tool-grants';

/** What each argument-target declaration of a call reaches. Null: not checked here (see the file comment). */
export type ArgTargets = Map<ToolGrantDeclaration, GrantCallTarget[] | null>;

interface Project { path: string; name: string; displayName?: string; id?: string }

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

/** The strings an argument holds: one, or a list. */
function refsOf(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string' && !!v.trim()).map((v) => v.trim());
  return [];
}

/** Per-call lookups, so a call reads each project's agents once. */
class Lookup {
  private projects: Promise<Project[]> | null = null;
  private agents = new Map<string, Promise<DurableAgentConfig[]>>();
  private policies = new Map<string, Promise<Map<string, { connectToDispatcher: boolean }>>>();

  constructor(readonly callerId: string, readonly callerProject: string | undefined) {}

  allProjects(): Promise<Project[]> {
    this.projects ??= Promise.resolve().then(() => projectStore.peekProjects()).then((list) => list as Project[], (): Project[] => []);
    return this.projects;
  }

  agentsIn(projectPath: string): Promise<DurableAgentConfig[]> {
    let list = this.agents.get(projectPath);
    if (!list) {
      // A peek: no cache load, watcher or recovery for a permission check.
      list = Promise.resolve().then(() => agentConfig.peekDurableConfigs(projectPath))
        .then((agents) => agents.filter((a) => !isDisposedAgent(a)), (): DurableAgentConfig[] => []);
      this.agents.set(projectPath, list);
    }
    return list;
  }

  /** Whether an agent has Connect to Dispatcher on, resolved as the Dispatcher's wires are (#2537). */
  async connectedToDispatcher(config: DurableAgentConfig, projectPath: string): Promise<boolean> {
    let policies = this.policies.get(projectPath);
    if (!policies) {
      policies = this.agentsIn(projectPath)
        .then((agents) => resolveOrchestrationPolicies(projectPath, [...agents]))
        .catch(() => new Map<string, { connectToDispatcher: boolean }>());
      this.policies.set(projectPath, policies);
    }
    return (await policies).get(config.id)?.connectToDispatcher === true;
  }

  /** A project by path, id or name. */
  async project(ref: string): Promise<Project | null> {
    const projects = await this.allProjects();
    const lower = ref.toLowerCase();
    return projects.find((p) => samePath(p.path, ref))
      ?? projects.find((p) => p.id === ref)
      ?? projects.find((p) => (p.displayName || p.name).toLowerCase() === lower || p.name.toLowerCase() === lower)
      ?? null;
  }

  /**
   * The agents a reference can mean (#2974). An id is looked up everywhere
   * before any name: the call's project, the caller's, a running agent's,
   * then every project. A name is looked up in the call's project, or among
   * the caller and its helpers (`self_and_helpers`, as the connection tools
   * place names), or else in the caller's project; exact before any case.
   * Every agent a name matches is returned, so each is checked. Empty when
   * nothing matches.
   */
  async candidates(ref: string, inProject: string | undefined, names: 'project' | 'self_and_helpers' | 'registered'): Promise<Array<{ config: DurableAgentConfig; projectPath: string }>> {
    let dispatcher: { config: DurableAgentConfig | null; path: string | null } | undefined;
    if (isDispatcherCoordinatorId(ref) || names === 'registered') {
      try { dispatcher = await import('../dispatcher/dispatcher-service').then((m) => m.getDispatcherState()); } catch { /* telemetry-exempt: lookup continues with registered agents */ }
      if (dispatcher?.config && dispatcher.path && ref === dispatcher.config.id) return [{ config: dispatcher.config, projectPath: dispatcher.path }];
    }
    const quick = agentRegistry.get(ref);
    if (quick && mcpCallerKind(ref) === 'quick') return [{ config: { id: ref, name: ref, color: 'indigo', createdAt: new Date().toISOString() } as DurableAgentConfig, projectPath: quick.projectPath }];
    const byId = await this.byId(ref, inProject);
    if (byId) return [byId];
    const pool: Array<{ config: DurableAgentConfig; projectPath: string }> = [];
    if (inProject) {
      for (const config of await this.agentsIn(inProject)) pool.push({ config, projectPath: inProject });
    } else if (names === 'self_and_helpers' || names === 'registered') {
      for (const p of (await this.allProjects()).map((x) => x.path)) {
        for (const config of await this.agentsIn(p)) {
          if (names === 'registered' || config.id === this.callerId || config.parentAgentId === this.callerId) pool.push({ config, projectPath: p });
        }
      }
    } else if (this.callerProject) {
      for (const config of await this.agentsIn(this.callerProject)) pool.push({ config, projectPath: this.callerProject });
    }
    if (dispatcher?.config && dispatcher.path && names === 'registered') pool.push({ config: dispatcher.config, projectPath: dispatcher.path });
    const exact = pool.filter((c) => c.config.name === ref);
    return exact.length > 0 ? exact : pool.filter((c) => c.config.name.toLowerCase() === ref.toLowerCase());
  }

  private async byId(ref: string, inProject: string | undefined): Promise<{ config: DurableAgentConfig; projectPath: string } | null> {
    const order = [inProject, this.callerProject, agentRegistry.get(ref)?.projectPath].filter((p): p is string => !!p);
    const all = (await this.allProjects()).map((p) => p.path);
    const seen: string[] = [];
    for (const p of [...order, ...all]) {
      if (seen.some((x) => samePath(x, p))) continue;
      seen.push(p);
      const found = (await this.agentsIn(p)).find((a) => a.id === ref);
      if (found) return { config: found, projectPath: p };
    }
    return null;
  }
}

/** How a resolved agent stands to the caller. */
async function agentTarget(lookup: Lookup, config: DurableAgentConfig, projectPath: string): Promise<GrantCallTarget> {
  const caller = lookup.callerId;
  const relations: Array<NonNullable<GrantCallTarget['relations']>[number]> = [];
  if (config.id === caller) relations.push('self');
  if (mcpCallerParent(caller) === config.id) relations.push('parent');
  if (config.parentAgentId === caller) relations.push('my_helper');
  const connected = await isConnected(lookup, config, projectPath);
  if (connected) relations.push('connected');
  const wakeOn = connected && localConnectionWakeOn(caller, config.id);
  return { kind: 'agent', agentId: config.id, relations, projectPath, isDispatcher: isTrackedDispatcher(config.id) || isDispatcherCoordinatorId(config.id), ...(wakeOn && { wakeOn: true }) };
}

/** Build permission facts from an already resolved target; never resolves the reference again. */
export function resolvedAgentGrantTarget(callerId: string, config: DurableAgentConfig, projectPath: string): Promise<GrantCallTarget> {
  return agentTarget(new Lookup(callerId, agentRegistry.get(callerId)?.projectPath), config, projectPath);
}

/**
 * Connected to the caller: for the Dispatcher, an agent with Connect to
 * Dispatcher on; for any other agent, one it has a wire to.
 */
async function isConnected(lookup: Lookup, target: DurableAgentConfig, projectPath: string): Promise<boolean> {
  if (isDispatcherAgent(lookup.callerId)) return lookup.connectedToDispatcher(target, projectPath);
  return bindingManager.getBindingsForAgent(lookup.callerId).some((b) => b.targetKind === 'agent' && b.targetId === target.id);
}

async function resolveDeclaration(lookup: Lookup, d: ToolGrantDeclaration, args: Record<string, unknown>): Promise<GrantCallTarget[] | null> {
  const from = d.from;
  if (!from) return null;
  let inProject: string | undefined;
  if (from.project) {
    const projectRef = refsOf(args[from.project])[0];
    if (projectRef) {
      const p = await lookup.project(projectRef);
      if (!p) return null;
      inProject = p.path;
    }
  }
  if (from.all && args[from.all] === true) {
    // Every agent in a project (the call's, else the caller's), or every project.
    if (d.target === 'project_arg') return [{ kind: 'project' }];
    const projectPath = inProject ?? lookup.callerProject;
    return [{ kind: 'agent', relations: [], ...(projectPath && { projectPath }) }];
  }
  const refs = from.args.flatMap((a) => refsOf(args[a]));
  if (d.target === 'group_project_arg') {
    const projects = await groupProjectRegistry.list();
    return refs.flatMap((ref) => {
      const matches = projects.filter((p) => p.id === ref || p.name.toLowerCase() === ref.toLowerCase());
      return matches.map((p): GrantCallTarget => {
        const member = bindingManager.getBindingsForAgent(lookup.callerId).some((b) => b.targetKind === 'group-project' && b.targetId === p.id);
        // Its id, so a grant on this one group project covers it (#3360); lead and admin are such grants, not a role here.
        return { kind: 'group_project', groupRole: member ? 'member' : null, groupProjectId: p.id };
      });
    });
  }
  if (d.target === 'project_arg') {
    // Adding or opening a project (#3050): the folder usually isn't a project yet, so it can't be left
    // to the tool like an unknown project. A path is checked as that folder; anything else (or nothing)
    // as a project no single-path grant covers, so only a grant on every project does.
    const adds = d.actions.includes('project.add');
    if (refs.length === 0) {
      if (from.missing === 'caller' && lookup.callerProject) return [{ kind: 'project', projectPath: lookup.callerProject }];
      return adds ? [{ kind: 'project' }] : null;
    }
    const out: GrantCallTarget[] = [];
    for (const ref of refs) {
      const p = await lookup.project(ref);
      if (p) out.push({ kind: 'project', projectPath: p.path });
      else if (adds) out.push(path.isAbsolute(ref) ? { kind: 'project', projectPath: path.resolve(ref) } : { kind: 'project' });
    }
    return out;
  }
  // agent_arg
  if (refs.length === 0) {
    if (from.missing !== 'caller') return null;
    return [{ kind: 'agent', agentId: lookup.callerId, relations: ['self'], ...(lookup.callerProject && { projectPath: lookup.callerProject }), isDispatcher: isTrackedDispatcher(lookup.callerId) }];
  }
  // Each reference on its own: one that matches nothing is left to the tool; one that matches
  // several agents (a shared name) is checked against every one of them.
  const out: GrantCallTarget[] = [];
  for (const ref of refs) {
    const remote = d.allowRemote ? parseAgentAddress(ref) : undefined;
    if (remote?.machine) {
      const connected = bindingManager.getBindingsForAgent(lookup.callerId).some((b) => b.targetKind === 'agent' && b.targetId === ref);
      out.push({ kind: 'agent', agentId: ref, relations: connected ? ['connected'] : [] });
      continue;
    }
    const candidates = await lookup.candidates(ref, inProject, from.names ?? 'project');
    if (candidates.length === 0 && ref === lookup.callerId && (d.strictTargets || d.allowRemote)) {
      out.push({ kind: 'agent', agentId: lookup.callerId, relations: ['self'], ...(lookup.callerProject && { projectPath: lookup.callerProject }), isDispatcher: isTrackedDispatcher(lookup.callerId) });
      continue;
    }
    if (candidates.length === 0 && (d.strictTargets || d.allowRemote)) out.push({ kind: 'agent', relations: [] });
    for (const found of candidates) out.push(await agentTarget(lookup, found.config, found.projectPath));
  }
  return out;
}

export type HandoffGrantTargetResolver = (callerId: string, args: Record<string, unknown>) => Promise<GrantCallTarget>;
let handoffTargetResolver: HandoffGrantTargetResolver | undefined;
export function setHandoffGrantTargetResolver(resolver: HandoffGrantTargetResolver): void { handoffTargetResolver = resolver; }

/** Resolve every argument-target declaration of a call. Empty when the tool has none. */
export async function resolveArgTargets(callerId: string, grant: ToolGrant | undefined, args: Record<string, unknown>): Promise<ArgTargets> {
  const out: ArgTargets = new Map();
  if (!grant) return out;
  const declarations = toolGrantDeclarations(grant).filter((d) => d.target === 'handoff_peer' || (d.target === 'agent_arg' || d.target === 'project_arg' || d.target === 'group_project_arg') && d.from);
  if (declarations.length === 0) return out;
  const lookup = new Lookup(callerId, agentRegistry.get(callerId)?.projectPath);
  for (const d of declarations) {
    try {
      if (d.target === 'handoff_peer') out.set(d, handoffTargetResolver ? [await handoffTargetResolver(callerId, args)] : null);
      else out.set(d, await resolveDeclaration(lookup, d, args));
    } catch {
      // telemetry-exempt: unresolved, so not checked here; the tool's own checks still run.
      out.set(d, d.target === 'group_project_arg' ? [{ kind: 'group_project', groupRole: null }] : d.strictTargets || d.allowRemote ? [{ kind: 'agent', relations: [] }] : null);
    }
  }
  return out;
}
