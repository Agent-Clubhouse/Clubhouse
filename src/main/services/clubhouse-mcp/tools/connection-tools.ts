/**
 * Connection tools (#2230): let an orchestrator connect itself and its own
 * helpers without the canvas. All are in the `orchestration` tool group, so
 * only an agent with orchestration on sees them.
 *
 * Scope: every agent named must be the caller or one of its (live, direct)
 * helpers, and only group projects the caller created through these tools or
 * already belongs to can be changed. Group projects created here record the
 * caller as `metadata.createdByAgentId`.
 *
 * Connections are written to the caller's project store first
 * (services/orchestrator-connections.ts), then bound live through
 * {@link claimSourceBinding}, so they come back at startup through the
 * `orchestrator-connections` binding source. A join made here is announced
 * like a wire the user drew; the startup rebuild stays silent. Disconnecting
 * removes the stored entry and the live binding, unless a canvas wire, a zone
 * or a helper wire also holds the pair: those are never removed here.
 */

import { registerGlobalTool } from '../tool-registry';
import { bindingManager } from '../binding-manager';
import type { McpToolResult } from '../types';
import { McpArgError, optionalBoolean, requireString } from './validation';
import { getAgentProjectPath } from '../../agent-registry';
import * as agentConfig from '../../agent-config';
import * as projectStore from '../../project-store';
import { groupProjectRegistry } from '../../group-project-registry';
import { bootstrapGroupProjectAdmin } from '../../group-project-admin-service';
import {
  claimSourceBinding,
  isBindingRemovedByUser,
  rebuildPersistedBindings,
  releaseSourceBinding,
  type PersistedBinding,
} from '../../persisted-bindings';
import {
  ORCHESTRATOR_CONNECTION_SOURCE_ID,
  addConnections,
  removeConnections,
  type OrchestratorConnection,
} from '../../orchestrator-connections';
import { appLog } from '../../log-service';
import type { DurableAgentConfig } from '../../../../shared/types';
import type { GroupProject } from '../../../../shared/group-project-types';

/** Metadata key naming the agent that created a group project through these tools. */
export const GROUP_PROJECT_CREATOR_KEY = 'createdByAgentId';

const MAX_GROUP_PROJECT_NAME = 100;

export class ConnectionScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionScopeError';
  }
}

function text(message: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text: message }], isError };
}

interface CallerScope {
  projectPath: string;
  projectName?: string;
  caller: DurableAgentConfig;
  /** The caller and its live direct helpers. */
  agents: DurableAgentConfig[];
}

async function callerScope(callerId: string): Promise<CallerScope> {
  const projectPath = getAgentProjectPath(callerId);
  if (!projectPath) throw new ConnectionScopeError('Could not find your project. Connection tools need a running durable agent.');
  const caller = await agentConfig.getDurableConfig(projectPath, callerId);
  if (!caller) throw new ConnectionScopeError('Connection tools are only for durable agents.');
  const helpers = await agentConfig.listHelpers(projectPath, callerId);
  const project = (await projectStore.list()).find((p) => p.path === projectPath);
  return {
    projectPath,
    projectName: project ? project.displayName || project.name : undefined,
    caller,
    agents: [caller, ...helpers],
  };
}

/** Find `ref` (an id or a name) among the caller and its helpers. */
function resolveAgent(scope: CallerScope, ref: string, field: string): DurableAgentConfig {
  const wanted = ref.trim();
  const byId = scope.agents.find((a) => a.id === wanted);
  if (byId) return byId;
  const exact = scope.agents.filter((a) => a.name === wanted);
  const candidates = exact.length > 0 ? exact : scope.agents.filter((a) => a.name.toLowerCase() === wanted.toLowerCase());
  if (candidates.length > 1) {
    throw new ConnectionScopeError(`More than one of you and your helpers is named "${ref}". Use an id: ${candidates.map((a) => a.id).join(', ')}.`);
  }
  if (candidates.length === 0) {
    throw new ConnectionScopeError(
      `${field} "${ref}" is not you or one of your helpers. These tools only connect you and your own helpers.`,
    );
  }
  return candidates[0];
}

function isMember(agentId: string, groupProjectId: string): boolean {
  return bindingManager.getBindingsForAgent(agentId).some((b) => b.targetKind === 'group-project' && b.targetId === groupProjectId);
}

/** Group projects the caller created through these tools or belongs to. */
async function groupProjectsInScope(callerId: string): Promise<GroupProject[]> {
  const all = await groupProjectRegistry.list();
  return all.filter((p) => p.metadata?.[GROUP_PROJECT_CREATOR_KEY] === callerId || isMember(callerId, p.id));
}

async function resolveGroupProject(callerId: string, ref: string): Promise<GroupProject> {
  const wanted = ref.trim();
  const projects = await groupProjectsInScope(callerId);
  const byId = projects.find((p) => p.id === wanted);
  if (byId) return byId;
  const byName = projects.filter((p) => p.name === wanted);
  const candidates = byName.length > 0 ? byName : projects.filter((p) => p.name.toLowerCase() === wanted.toLowerCase());
  if (candidates.length > 1) {
    throw new ConnectionScopeError(`More than one group project is named "${ref}". Use its id: ${candidates.map((p) => p.id).join(', ')}.`);
  }
  if (candidates.length === 0) {
    throw new ConnectionScopeError(`No group project "${ref}" that you created or belong to.`);
  }
  return candidates[0];
}

function agentWire(scope: CallerScope, from: DurableAgentConfig, to: DurableAgentConfig): PersistedBinding {
  return {
    agentId: from.id, targetId: to.id, targetKind: 'agent', label: to.name,
    agentName: from.name, targetName: to.name, ...(scope.projectName ? { projectName: scope.projectName } : {}),
  };
}

function membership(agent: DurableAgentConfig, project: GroupProject): PersistedBinding {
  return { agentId: agent.id, targetId: project.id, targetKind: 'group-project', label: project.name, agentName: agent.name, targetName: project.name };
}

function entryFor(callerId: string, binding: PersistedBinding): OrchestratorConnection {
  return {
    ownerId: callerId,
    agentId: binding.agentId,
    targetId: binding.targetId,
    targetKind: binding.targetKind as OrchestratorConnection['targetKind'],
    createdAt: new Date().toISOString(),
  };
}

/**
 * Store the connections, then bind them live. Returns how each binding went.
 * A rebuild runs afterwards, so the source's view matches its store again.
 */
async function connect(callerId: string, scope: CallerScope, bindings: PersistedBinding[]): Promise<Array<'created' | 'existing' | 'removed' | 'invalid'>> {
  // A pair the user removed this session stays removed: only the user can draw it again.
  const refused = bindings.find((b) => isBindingRemovedByUser(b.agentId, b.targetId));
  if (refused) {
    throw new ConnectionScopeError(`The user removed this connection. ${refused.agentName} → ${refused.targetName} stays disconnected until the user connects it again.`);
  }
  await addConnections(scope.projectPath, bindings.map((b) => entryFor(callerId, b)));
  const outcomes = bindings.map((b) => {
    const outcome = claimSourceBinding(ORCHESTRATOR_CONNECTION_SOURCE_ID, b);
    // Same as a group-project join the user draws: the first member leads.
    if (outcome === 'created' && b.targetKind === 'group-project') void bootstrapGroupProjectAdmin(b.targetId, b.agentId);
    return outcome;
  });
  // The user removed a pair between the check above and the claim: don't keep it.
  const refusedNow = bindings.filter((_, i) => outcomes[i] === 'removed');
  if (refusedNow.length > 0) {
    await removeConnections(scope.projectPath, callerId, (c) => refusedNow.some((b) => b.agentId === c.agentId && b.targetId === c.targetId));
  }
  await rebuildPersistedBindings();
  return outcomes;
}

/**
 * Remove the caller's stored connections, then their live bindings where this
 * source owns them and no other stored entry still lists the pair.
 */
async function disconnect(callerId: string, scope: CallerScope, pairs: Array<{ agentId: string; targetId: string }>): Promise<{
  stored: number;
  outcomes: Array<'unbound' | 'kept' | 'absent'>;
}> {
  const { removed, remaining } = await removeConnections(
    scope.projectPath,
    callerId,
    (c) => pairs.some((p) => p.agentId === c.agentId && p.targetId === c.targetId),
  );
  const outcomes = pairs.map((p) => {
    if (remaining.some((c) => c.agentId === p.agentId && c.targetId === p.targetId)) return 'kept' as const;
    return releaseSourceBinding(ORCHESTRATOR_CONNECTION_SOURCE_ID, p.agentId, p.targetId);
  });
  await rebuildPersistedBindings();
  return { stored: removed.length, outcomes };
}

function errorResult(tool: string, callerId: string, err: unknown): McpToolResult {
  if (err instanceof ConnectionScopeError || err instanceof McpArgError) return text(err.message, true);
  const message = err instanceof Error ? err.message : String(err);
  appLog('core:mcp', 'error', `${tool} failed`, { meta: { agentId: callerId, error: message } });
  return text(`${tool} failed: ${message}`, true);
}

const STAYS_NOTE = 'It stays connected because a canvas wire, zone or helper link also connects it; change that on the canvas.';

function membershipMessage(agent: DurableAgentConfig, project: GroupProject, outcome: 'created' | 'existing' | 'removed' | 'invalid'): string {
  if (outcome === 'created') return `${agent.name} joined "${project.name}".`;
  if (outcome === 'existing') return `${agent.name} was already in "${project.name}"; the membership is now saved.`;
  if (outcome === 'removed') return `The user removed this connection: ${agent.name} stays out of "${project.name}".`;
  return `${agent.name} could not join "${project.name}".`;
}

async function handleCreateGroupProject(callerId: string, args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const name = requireString(args, 'name').trim();
    if (!name) throw new McpArgError('name must not be empty');
    if (name.length > MAX_GROUP_PROJECT_NAME) throw new McpArgError(`name must be at most ${MAX_GROUP_PROJECT_NAME} characters`);
    const rawMembers = args.members ?? [];
    if (!Array.isArray(rawMembers) || rawMembers.some((m) => typeof m !== 'string')) {
      throw new McpArgError('members must be an array of agent names or ids');
    }
    const scope = await callerScope(callerId);
    // Resolve everyone before creating anything, so a bad name creates nothing.
    const members: DurableAgentConfig[] = [];
    for (const ref of rawMembers as string[]) {
      const agent = resolveAgent(scope, ref, 'Member');
      if (!members.some((m) => m.id === agent.id)) members.push(agent);
    }
    // The first member to join leads the project: the caller, when it joins.
    members.sort((a, b) => Number(b.id === callerId) - Number(a.id === callerId));

    const created = await groupProjectRegistry.create(name);
    const project = (await groupProjectRegistry.update(created.id, { metadata: { [GROUP_PROJECT_CREATOR_KEY]: callerId } })) ?? created;
    appLog('core:mcp', 'info', 'Orchestrator created a group project', {
      meta: { agentId: callerId, groupProjectId: project.id, members: members.length },
    });
    const lines = [`Created group project "${project.name}" (id ${project.id}).`];
    if (members.length > 0) {
      const outcomes = await connect(callerId, scope, members.map((m) => membership(m, project)));
      members.forEach((m, i) => lines.push(membershipMessage(m, project, outcomes[i])));
    }
    return text(lines.join('\n'));
  } catch (err) {
    // telemetry-exempt: errorResult logs unexpected failures and returns them to the calling agent
    return errorResult('create_group_project', callerId, err);
  }
}

async function handleAddToGroupProject(callerId: string, args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const projectRef = requireString(args, 'project');
    const helperRef = requireString(args, 'helper');
    const scope = await callerScope(callerId);
    const agent = resolveAgent(scope, helperRef, 'helper');
    const project = await resolveGroupProject(callerId, projectRef);
    const [outcome] = await connect(callerId, scope, [membership(agent, project)]);
    return text(membershipMessage(agent, project, outcome), outcome === 'invalid' || outcome === 'removed');
  } catch (err) {
    // telemetry-exempt: errorResult logs unexpected failures and returns them to the calling agent
    return errorResult('add_to_group_project', callerId, err);
  }
}

async function handleRemoveFromGroupProject(callerId: string, args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const projectRef = requireString(args, 'project');
    const helperRef = requireString(args, 'helper');
    const scope = await callerScope(callerId);
    const agent = resolveAgent(scope, helperRef, 'helper');
    const project = await resolveGroupProject(callerId, projectRef);
    const { stored, outcomes: [outcome] } = await disconnect(callerId, scope, [{ agentId: agent.id, targetId: project.id }]);
    if (outcome === 'unbound') return text(`${agent.name} left "${project.name}".`);
    if (outcome === 'kept') {
      return text(`${stored > 0 ? 'Removed the saved membership. ' : ''}${agent.name} is still in "${project.name}". ${STAYS_NOTE}`);
    }
    return text(stored > 0 ? `Removed the saved membership; ${agent.name} was not in "${project.name}".` : `${agent.name} is not in "${project.name}".`);
  } catch (err) {
    // telemetry-exempt: errorResult logs unexpected failures and returns them to the calling agent
    return errorResult('remove_from_group_project', callerId, err);
  }
}

function readPair(scope: CallerScope, args: Record<string, unknown>): { from: DurableAgentConfig; to: DurableAgentConfig; twoWay: boolean } {
  const from = resolveAgent(scope, requireString(args, 'from'), 'from');
  const to = resolveAgent(scope, requireString(args, 'to'), 'to');
  if (from.id === to.id) throw new McpArgError('from and to must be different agents');
  return { from, to, twoWay: optionalBoolean(args, 'twoWay') ?? false };
}

async function handleConnectAgents(callerId: string, args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const scope = await callerScope(callerId);
    const { from, to, twoWay } = readPair(scope, args);
    const wires = [agentWire(scope, from, to), ...(twoWay ? [agentWire(scope, to, from)] : [])];
    const outcomes = await connect(callerId, scope, wires);
    const lines = wires.map((w, i) => {
      const label = `${w.agentName} → ${w.targetName}`;
      if (outcomes[i] === 'created') return `Connected ${label}.`;
      if (outcomes[i] === 'existing') return `${label} was already connected; the connection is now saved.`;
      if (outcomes[i] === 'removed') return `The user removed this connection (${label}).`;
      return `Could not connect ${label}.`;
    });
    return text(lines.join('\n'), outcomes.some((o) => o === 'invalid' || o === 'removed'));
  } catch (err) {
    // telemetry-exempt: errorResult logs unexpected failures and returns them to the calling agent
    return errorResult('connect_agents', callerId, err);
  }
}

async function handleDisconnectAgents(callerId: string, args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const scope = await callerScope(callerId);
    const { from, to, twoWay } = readPair(scope, args);
    const pairs = [{ agentId: from.id, targetId: to.id, label: `${from.name} → ${to.name}` }];
    if (twoWay) pairs.push({ agentId: to.id, targetId: from.id, label: `${to.name} → ${from.name}` });
    const { outcomes } = await disconnect(callerId, scope, pairs);
    const lines = pairs.map((p, i) => {
      if (outcomes[i] === 'unbound') return `Disconnected ${p.label}.`;
      if (outcomes[i] === 'kept') return `${p.label}: removed the saved connection. ${STAYS_NOTE}`;
      return `${p.label} was not connected.`;
    });
    return text(lines.join('\n'));
  } catch (err) {
    // telemetry-exempt: errorResult logs unexpected failures and returns them to the calling agent
    return errorResult('disconnect_agents', callerId, err);
  }
}

const AGENT_REF = 'An agent name or id: you or one of your helpers.';
const PROJECT_REF = 'A group project name or id: one you created with create_group_project or already belong to.';

/** Register the orchestrator connection tools. */
export function registerConnectionTools(): void {
  const options = { group: 'orchestration' as const };

  registerGlobalTool('create_group_project', {
    description:
      'Create a group project (a shared bulletin board) and optionally add members to it. ' +
      'Members must be you or your helpers; include yourself to join it too. ' +
      'Memberships are saved and come back when Clubhouse restarts.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The group project name.' },
        members: { type: 'array', items: { type: 'string' }, description: `Agents to add. Each is ${AGENT_REF.toLowerCase()}` },
      },
      required: ['name'],
    },
  }, handleCreateGroupProject, options);

  registerGlobalTool('add_to_group_project', {
    description: 'Add you or one of your helpers to a group project. The membership is saved and comes back when Clubhouse restarts.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: PROJECT_REF },
        helper: { type: 'string', description: AGENT_REF },
      },
      required: ['project', 'helper'],
    },
  }, handleAddToGroupProject, options);

  registerGlobalTool('remove_from_group_project', {
    description: 'Remove you or one of your helpers from a group project. Memberships made on the canvas stay; change those on the canvas.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: PROJECT_REF },
        helper: { type: 'string', description: AGENT_REF },
      },
      required: ['project', 'helper'],
    },
  }, handleRemoveFromGroupProject, options);

  registerGlobalTool('connect_agents', {
    description:
      'Connect two agents so `from` gets tools to message and check on `to`. Both must be you or your helpers. ' +
      'Set twoWay to connect both directions. The connection is saved and comes back when Clubhouse restarts.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: AGENT_REF },
        to: { type: 'string', description: AGENT_REF },
        twoWay: { type: 'boolean', description: 'Also connect `to` back to `from`. Default false.' },
      },
      required: ['from', 'to'],
    },
  }, handleConnectAgents, options);

  registerGlobalTool('disconnect_agents', {
    description:
      'Remove a connection made with connect_agents. Set twoWay to remove both directions. ' +
      'Connections drawn on the canvas, and the link between you and your helpers, stay.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: AGENT_REF },
        to: { type: 'string', description: AGENT_REF },
        twoWay: { type: 'boolean', description: 'Also remove `to` → `from`. Default false.' },
      },
      required: ['from', 'to'],
    },
  }, handleDisconnectAgents, options);
}
