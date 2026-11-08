/**
 * Targets named in a call's arguments (#2974, part of #2921): the agents and
 * projects an `agent_arg` or `project_arg` declaration reaches, resolved
 * before the grant check so it decides these calls too. Each declaration says
 * which arguments name its target (`from`).
 *
 * Only call time resolves them: a listing passes no arguments. A reference
 * that doesn't resolve (an unknown id, a name it can't place) is left to the
 * tool, which says it wasn't found, so a refusal never says whether a target
 * exists.
 */

import * as path from 'path';
import type { GrantCallTarget } from '../../../shared/agent-grants';
import type { DurableAgentConfig } from '../../../shared/types';
import * as agentConfig from '../agent-config';
import { agentRegistry } from '../agent-registry';
import { resolveOrchestrationPolicies } from '../orchestration-policy';
import * as projectStore from '../project-store';
import { bindingManager } from './binding-manager';
import { isDispatcherAgent, isTrackedDispatcher } from './dispatcher-gate';
import { mcpCallerParent } from './mcp-call-gate';
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
      list = Promise.resolve().then(() => agentConfig.listDurable(projectPath)).catch((): DurableAgentConfig[] => []);
      this.agents.set(projectPath, list);
    }
    return list;
  }

  /** Whether an agent has Connect to Dispatcher on, resolved as the Dispatcher's wires are (#2537). */
  async connectedToDispatcher(config: DurableAgentConfig, projectPath: string): Promise<boolean> {
    let policies = this.policies.get(projectPath);
    if (!policies) {
      policies = this.agentsIn(projectPath)
        .then((agents) => resolveOrchestrationPolicies(projectPath, agents))
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
   * An agent by id anywhere, or by name in one project (the call's `project`
   * argument, else the caller's). A name used twice there doesn't resolve.
   */
  async agent(ref: string, inProject?: string): Promise<{ config: DurableAgentConfig; projectPath: string } | null> {
    const home = inProject ?? this.callerProject;
    const searched: string[] = [];
    if (home) {
      searched.push(home);
      const list = await this.agentsIn(home);
      const byId = list.find((a) => a.id === ref);
      if (byId) return { config: byId, projectPath: home };
      const named = list.filter((a) => a.name === ref);
      if (named.length === 1) return { config: named[0], projectPath: home };
      if (named.length > 1) return null;
    }
    if (inProject) return null;
    // By id elsewhere: a running agent's project first, then every project.
    const running = agentRegistry.get(ref)?.projectPath;
    const others = running ? [running] : (await this.allProjects()).map((p) => p.path);
    for (const p of others) {
      if (searched.some((s) => samePath(s, p))) continue;
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
  if (await isConnected(lookup, config, projectPath)) relations.push('connected');
  return { kind: 'agent', relations, projectPath, isDispatcher: isTrackedDispatcher(config.id) };
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
  if (from.all && args[from.all] === true) {
    // Every agent, or every project: what only an `any` grant covers.
    return [d.target === 'agent_arg' ? { kind: 'agent', relations: [] } : { kind: 'project' }];
  }
  const refs = from.args.flatMap((a) => refsOf(args[a]));
  if (d.target === 'project_arg') {
    if (refs.length === 0) return from.missing === 'caller' && lookup.callerProject ? [{ kind: 'project', projectPath: lookup.callerProject }] : null;
    const out: GrantCallTarget[] = [];
    for (const ref of refs) {
      const p = await lookup.project(ref);
      if (!p) return null;
      out.push({ kind: 'project', projectPath: p.path });
    }
    return out;
  }
  // agent_arg
  if (refs.length === 0) {
    if (from.missing !== 'caller') return null;
    return [{ kind: 'agent', relations: ['self'], ...(lookup.callerProject && { projectPath: lookup.callerProject }), isDispatcher: isTrackedDispatcher(lookup.callerId) }];
  }
  let inProject: string | undefined;
  if (from.project) {
    const projectRef = refsOf(args[from.project])[0];
    if (projectRef) {
      const p = await lookup.project(projectRef);
      if (!p) return null;
      inProject = p.path;
    }
  }
  const out: GrantCallTarget[] = [];
  for (const ref of refs) {
    const found = await lookup.agent(ref, inProject);
    if (!found) return null;
    out.push(await agentTarget(lookup, found.config, found.projectPath));
  }
  return out;
}

/** Resolve every argument-target declaration of a call. Empty when the tool has none. */
export async function resolveArgTargets(callerId: string, grant: ToolGrant | undefined, args: Record<string, unknown>): Promise<ArgTargets> {
  const out: ArgTargets = new Map();
  if (!grant) return out;
  const declarations = toolGrantDeclarations(grant).filter((d) => (d.target === 'agent_arg' || d.target === 'project_arg') && d.from);
  if (declarations.length === 0) return out;
  const lookup = new Lookup(callerId, agentRegistry.get(callerId)?.projectPath);
  for (const d of declarations) {
    try {
      out.set(d, await resolveDeclaration(lookup, d, args));
    } catch {
      // telemetry-exempt: unresolved, so not checked here; the tool's own checks still run.
      out.set(d, null);
    }
  }
  return out;
}
