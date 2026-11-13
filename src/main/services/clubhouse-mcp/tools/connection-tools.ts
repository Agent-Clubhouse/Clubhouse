/**
 * Connection tools (#2230, #3336): any durable agent may manage connections
 * covered by its connection.manage grants. The original group-project tools
 * retain their orchestration scope; join and leave use independent grants.
 *
 * Agent connections resolve registered durable agents, the Dispatcher, and
 * network addresses, and check grants on both ends. Legacy group-project
 * tools still name the caller and its live direct helpers, and projects the
 * caller created or belongs to.
 * Group projects created here record the caller as `metadata.createdByAgentId`.
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
import { agentRegistry, getAgentProjectPath } from '../../agent-registry';
import * as agentConfig from '../../agent-config';
import * as projectStore from '../../project-store';
import { listHelpersEverywhere } from '../../helper-index';
import { groupProjectRegistry } from '../../group-project-registry';
import { groupProjectHost } from '../../group-project-host';
import { bootstrapGroupProjectAdmin } from '../../group-project-admin-service';
import {
  addMember as addGroupMember, beginAutoJoin, excludeMember as excludeGroupMember, isMember as isGroupMember, isMembershipManaged,
} from '../../group-project-membership';
import {
  claimSourceBinding,
  collectSourcesByPair,
  isBindingRemovedByUser,
  isSourceRemovedByUser,
  rebuildPersistedBindings,
  releaseSourceBinding,
  type PersistedBinding,
} from '../../persisted-bindings';
import {
  ORCHESTRATOR_CONNECTION_SOURCE_ID,
  addConnections,
  removeConnections,
  readConnections,
  type OrchestratorConnection,
} from '../../orchestrator-connections';
import { appLog } from '../../log-service';
import { getConnectionDirection, setConnectionDirections, listAllConnectionDirections, updateAgentNetworkLinks, type DirectionToolsChange } from '../../connection-grants-store';
import { activeAgentLinks, CONNECTION_SWITCHES, NEW_CONNECTION_DISABLED_TOOLS, NEW_CONNECTION_ENABLED_TOOLS, localToolsFromAllow } from '../../../../shared/connection-grants';
import { isDisposedAgent } from '../../../../shared/agent-helpers';
import { isDispatcherAgent, isDispatcherCoordinatorId, isTrackedDispatcher } from '../dispatcher-gate';
import { holdsGrant } from '../grant-check';
import { mcpCallerKind } from '../mcp-call-gate';
import { bindingTargetOf, connectionEnd, readLocalDirectionTools } from '../../connection-grants';
import { DispatcherControlError, setConnectionToolsForLink } from '../../dispatcher-controls';
import { recordDispatcherControl } from '../../../telemetry/dispatcher-telemetry';
import type { DurableAgentConfig } from '../../../../shared/types';
import type { GroupProject } from '../../../../shared/group-project-types';
import type { GrantCallTarget } from '../../../../shared/agent-grants';
import * as annexIdentity from '../../annex-identity';
import { isNetworkComputer, syncDirectionsWith } from '../../annex-agent-calls';

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
  caller: DurableAgentConfig;
  /** The caller and its live direct helpers, in every project. */
  agents: DurableAgentConfig[];
  /** agent id → the name of the project holding it. */
  projectNames: Map<string, string | undefined>;
  /** agent id → the project holding it, for helpers in other projects only. */
  otherProjects: Map<string, string>;
  registered?: boolean;
  helperIds: ReadonlySet<string>;
  ephemeralOwner: boolean;
}

async function callerScope(callerId: string, registered = false): Promise<CallerScope> {
  const projectPath = getAgentProjectPath(callerId);
  if (!projectPath) throw new ConnectionScopeError('Could not find your project. Connection tools need a running durable agent.');
  const ephemeralOwner = mcpCallerKind(callerId) === 'quick';
  const savedCaller = await agentConfig.getDurableConfig(projectPath, callerId);
  const caller = savedCaller ?? (ephemeralOwner ? { id: callerId, name: callerId, color: 'indigo', createdAt: new Date().toISOString() } as DurableAgentConfig : null);
  if (!caller || isDisposedAgent(caller)) throw new ConnectionScopeError('Could not find your agent.');
  const [helpers, projects, dispatcher] = await Promise.all([listHelpersEverywhere(projectPath, callerId), projectStore.list(), import('../../dispatcher/dispatcher-service').then((m) => m.getDispatcherState())]);
  const nameOf = (p: string) => {
    const project = projects.find((candidate) => candidate.path === p);
    return project ? project.displayName || project.name : undefined;
  };
  const projectName = nameOf(projectPath);
  const entries = registered
    ? (await Promise.all(projects.map(async (p) => (await agentConfig.listDurable(p.path))
      .filter((a) => !isDisposedAgent(a)).map((config) => ({ projectPath: p.path, config }))))).flat()
    : [{ projectPath, config: caller }, ...helpers];
  if (registered && !entries.some((e) => e.config.id === caller.id)) entries.push({ projectPath, config: caller });
  if (registered) {
    for (const [id, registration] of agentRegistry.getAllRegistrations()) {
      if (mcpCallerKind(id) === 'quick' && !entries.some((entry) => entry.config.id === id)) {
        entries.push({ projectPath: registration.projectPath, config: { id, name: id, color: 'indigo', createdAt: new Date().toISOString() } as DurableAgentConfig });
      }
    }
  }
  if (registered && dispatcher.config && !entries.some((e) => e.config.id === dispatcher.config!.id)) entries.push({ projectPath, config: dispatcher.config });
  return {
    projectPath,
    caller,
    agents: entries.map((h) => h.config),
    projectNames: new Map([[caller.id, projectName], ...entries.map((h) => [h.config.id, nameOf(h.projectPath)] as const)]),
    otherProjects: new Map(entries.filter((h) => h.projectPath !== projectPath).map((h) => [h.config.id, h.projectPath])),
    registered,
    ephemeralOwner,
    helperIds: new Set(helpers.map((h) => h.config.id)),
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
    throw new ConnectionScopeError(`More than one ${scope.registered ? 'registered agent' : 'of you and your helpers'} is named "${ref}". Use an id: ${candidates.map((a) => a.id).join(', ')}.`);
  }
  if (candidates.length === 0) {
    throw new ConnectionScopeError(
      scope.registered ? `No available registered agent matches ${field} "${ref}". Use its id from a registered project.`
        : `${field} "${ref}" is not you or one of your helpers. These tools only connect you and your own helpers.`,
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

async function resolveGroupProject(callerId: string, ref: string, all = false): Promise<GroupProject> {
  const wanted = ref.trim();
  const projects = all ? await groupProjectRegistry.list() : await groupProjectsInScope(callerId);
  const byId = projects.find((p) => p.id === wanted);
  if (byId) return byId;
  const byName = projects.filter((p) => p.name === wanted);
  const candidates = byName.length > 0 ? byName : projects.filter((p) => p.name.toLowerCase() === wanted.toLowerCase());
  if (candidates.length > 1) {
    throw new ConnectionScopeError(`More than one group project is named "${ref}". Use its id: ${candidates.map((p) => p.id).join(', ')}.`);
  }
  if (candidates.length === 0) {
    throw new ConnectionScopeError(all ? `No group project matches "${ref}".` : `No group project "${ref}" that you created or belong to.`);
  }
  return candidates[0];
}

/** A wire from one agent to another, labelled with the target's project as a canvas wire is. */
function agentWire(scope: CallerScope, from: DurableAgentConfig, to: DurableAgentConfig): PersistedBinding {
  const projectName = scope.projectNames.get(to.id);
  return {
    agentId: from.id, targetId: to.id, targetKind: 'agent', label: to.name,
    agentName: from.name, targetName: to.name, ...(projectName ? { projectName } : {}),
  };
}

function membership(agent: DurableAgentConfig, project: GroupProject): PersistedBinding {
  return { agentId: agent.id, targetId: project.id, targetKind: 'group-project', label: project.name, agentName: agent.name, targetName: project.name };
}

/** Add an agent to a group project's membership record (#3357), the way a drawn wire does. */
async function joinRecord(agent: DurableAgentConfig, project: GroupProject): Promise<'created' | 'existing' | 'removed' | 'invalid'> {
  if (isBindingRemovedByUser(agent.id, project.id)) return 'removed';
  const before = await isGroupMember(project.id, agent.id);
  await addGroupMember(project.id, agent.id);
  if (before) return 'existing';
  void bootstrapGroupProjectAdmin(project.id, agent.id);
  return 'created';
}

function entryFor(callerId: string, scope: CallerScope, binding: PersistedBinding): OrchestratorConnection {
  const agentProjectPath = scope.otherProjects.get(binding.agentId);
  const targetProjectPath = binding.targetKind === 'agent' ? scope.otherProjects.get(binding.targetId) : undefined;
  return {
    ownerId: callerId,
    agentId: binding.agentId,
    targetId: binding.targetId,
    targetKind: binding.targetKind as OrchestratorConnection['targetKind'],
    createdAt: new Date().toISOString(),
    // An end in another project is recorded, so its entry is only pruned once that project says it's gone.
    ...(agentProjectPath ? { agentProjectPath } : {}),
    ...(targetProjectPath ? { targetProjectPath } : {}),
    ...((scope.ephemeralOwner || (scope.registered && [binding.agentId, binding.targetId].some((id) => id !== callerId && !scope.helperIds.has(id)))) && { scope: 'granted' as const }),
    ...(scope.ephemeralOwner && { ephemeralOwner: true }),
  };
}

/**
 * Store the connections, then bind them live. Returns how each binding went.
 * A rebuild runs afterwards, so the source's view matches its store again.
 */
async function connect(callerId: string, scope: CallerScope, bindings: PersistedBinding[], allow?: readonly (readonly string[] | undefined)[]): Promise<Array<'created' | 'existing' | 'removed' | 'invalid'>> {
  // A pair the user removed this session stays removed: only the user can draw it again.
  // Or one whose orchestrator link the user removed from the Connections card (#2744).
  const refused = bindings.find((b) => isBindingRemovedByUser(b.agentId, b.targetId) || isSourceRemovedByUser(ORCHESTRATOR_CONNECTION_SOURCE_ID, b.agentId, b.targetId));
  if (refused) {
    throw new ConnectionScopeError(`The user removed this connection. ${refused.agentName} → ${refused.targetName} stays disconnected until the user connects it again.`);
  }
  const added = await addConnections(scope.projectPath, bindings.map((b) => entryFor(callerId, scope, b)));
  // A new link between two agents starts like any new connection: send and wake, no clear or compact (#3215, #3214).
  // A pair already bound (a canvas wire, a helper link) or with tools saved keeps what it has.
  const changes = bindings.flatMap((b, i): DirectionToolsChange[] => {
    if (b.targetKind !== 'agent' || bindingManager.getBindingsForAgent(b.agentId).some((x) => x.targetId === b.targetId)) return [];
    return [{
      from: { agentId: b.agentId }, to: { agentId: b.targetId },
      ...(allow?.[i] ? localToolsFromAllow(allow[i]) : { disabledTools: NEW_CONNECTION_DISABLED_TOOLS, enabledTools: NEW_CONNECTION_ENABLED_TOOLS }),
    }];
  });
  try {
    if (changes.length > 0) await setConnectionDirections(changes, (current, change) => {
      if (!current) return;
      if (bindings.some((b, i) => allow?.[i] && b.agentId === change.from.agentId && b.targetId === change.to.agentId)) {
        throw new ConnectionScopeError('That direction acquired saved switches meanwhile. Nothing was changed; inspect it before trying again.');
      }
      return false;
    }, { agentId: callerId });
  } catch (err) {
    await removeConnections(scope.projectPath, callerId, (c) => added.some((b) => b.agentId === c.agentId && b.targetId === c.targetId));
    throw err;
  }
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
    if (!removed.some((c) => c.agentId === p.agentId && c.targetId === p.targetId)) {
      return bindingManager.getBindingsForAgent(p.agentId).some((b) => b.targetId === p.targetId) ? 'kept' as const : 'absent' as const;
    }
    if (remaining.some((c) => c.agentId === p.agentId && c.targetId === p.targetId)) return 'kept' as const;
    return releaseSourceBinding(ORCHESTRATOR_CONNECTION_SOURCE_ID, p.agentId, p.targetId);
  });
  await rebuildPersistedBindings();
  return { stored: removed.length, outcomes };
}

function errorResult(tool: string, callerId: string, err: unknown, args?: Record<string, unknown>): McpToolResult {
  const expected = err instanceof ConnectionScopeError || err instanceof McpArgError || err instanceof DispatcherControlError;
  if (args && (tool === 'connect_agents' || tool === 'disconnect_agents' || tool === 'set_connection_tools' || tool === 'join_group_project' || tool === 'leave_group_project')) {
    recordDispatcherControl({
      tool, actorId: callerId,
      targets: [args?.from ?? args?.agent, args?.to ?? args?.project].filter((v): v is string => typeof v === 'string'),
      outcome: expected ? 'refused' : 'error', code: expected ? err.name : 'error',
    });
  }
  if (expected) return text(err.message, true);
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

    const callerProject = (await projectStore.list()).find((project) => project.path === scope.projectPath);
    if (!callerProject) {
      throw new ConnectionScopeError('Your project is not registered. Register it before creating a group project.');
    }
    const created = await groupProjectHost.create(name, { projectId: callerProject.id });
    // Everyone in scope joins a new group project (#3357); the members named here are added.
    await beginAutoJoin(created.id);
    const project = (await groupProjectHost.update(created.id, { metadata: { [GROUP_PROJECT_CREATOR_KEY]: callerId } })) ?? created;
    appLog('core:mcp', 'info', 'Orchestrator created a group project', {
      meta: { agentId: callerId, groupProjectId: project.id, members: members.length },
    });
    const lines = [`Created group project "${project.name}" (id ${project.id}).`];
    // Its members are a record (#3357): agents in scope join by themselves, the rest are added.
    for (const m of members) lines.push(membershipMessage(m, project, await joinRecord(m, project)));
    return text(lines.join('\n'));
  } catch (err) {
    // telemetry-exempt: errorResult logs unexpected failures and returns them to the calling agent
    return errorResult('create_group_project', callerId, err);
  }
}

async function handleAddToGroupProject(callerId: string, args: Record<string, unknown>, granted = false): Promise<McpToolResult> {
  try {
    const projectRef = requireString(args, 'project');
    const helperRef = requireString(args, granted ? 'agent' : 'helper');
    const scope = await callerScope(callerId, granted);
    const agent = resolveAgent(scope, helperRef, 'helper');
    const project = await resolveGroupProject(callerId, projectRef, granted);
    const [outcome] = await isMembershipManaged(project.id)
      ? [await joinRecord(agent, project)]
      : await connect(callerId, scope, [membership(agent, project)]);
    if (granted) recordDispatcherControl({ tool: 'join_group_project', actorId: callerId, targets: [agent.id, project.id], outcome: outcome === 'created' || outcome === 'existing' ? 'ok' : 'refused' });
    return text(membershipMessage(agent, project, outcome), outcome === 'invalid' || outcome === 'removed');
  } catch (err) {
    // telemetry-exempt: errorResult logs unexpected failures and returns them to the calling agent
    return errorResult(granted ? 'join_group_project' : 'add_to_group_project', callerId, err, granted ? args : undefined);
  }
}

async function handleRemoveFromGroupProject(callerId: string, args: Record<string, unknown>, granted = false): Promise<McpToolResult> {
  try {
    const projectRef = requireString(args, 'project');
    const helperRef = requireString(args, granted ? 'agent' : 'helper');
    const scope = await callerScope(callerId, granted);
    const agent = resolveAgent(scope, helperRef, 'helper');
    const project = await resolveGroupProject(callerId, projectRef, granted);
    if (granted) {
      const owned = (await readConnections(scope.projectPath)).some((c) => c.ownerId === callerId && c.agentId === agent.id && c.targetId === project.id && c.targetKind === 'group-project');
      if (!owned && isMember(agent.id, project.id)) throw new ConnectionScopeError('You did not make that membership source.');
    }
    if (await isMembershipManaged(project.id)) {
      if (!(await isGroupMember(project.id, agent.id))) return text(`${agent.name} is not in "${project.name}".`);
      await excludeGroupMember(project.id, agent.id);
      return text(`${agent.name} left "${project.name}".`);
    }
    const { stored, outcomes: [outcome] } = await disconnect(callerId, scope, [{ agentId: agent.id, targetId: project.id }]);
    if (granted) recordDispatcherControl({ tool: 'leave_group_project', actorId: callerId, targets: [agent.id, project.id], outcome: 'ok' });
    if (outcome === 'unbound') return text(`${agent.name} left "${project.name}".`);
    if (outcome === 'kept') {
      return text(`${stored > 0 ? 'Removed the saved membership. ' : ''}${agent.name} is still in "${project.name}". ${STAYS_NOTE}`);
    }
    return text(stored > 0 ? `Removed the saved membership; ${agent.name} was not in "${project.name}".` : `${agent.name} is not in "${project.name}".`);
  } catch (err) {
    // telemetry-exempt: errorResult logs unexpected failures and returns them to the calling agent
    return errorResult(granted ? 'leave_group_project' : 'remove_from_group_project', callerId, err, granted ? args : undefined);
  }
}

function readPair(scope: CallerScope, args: Record<string, unknown>): { from: DurableAgentConfig; to: DurableAgentConfig; twoWay: boolean } {
  const from = resolveAgent(scope, requireString(args, 'from'), 'from');
  const to = resolveAgent(scope, requireString(args, 'to'), 'to');
  if (from.id === to.id) throw new McpArgError('from and to must be different agents');
  return { from, to, twoWay: optionalBoolean(args, 'twoWay') ?? optionalBoolean(args, 'two_way') ?? false };
}


function isRemotePair(args: Record<string, unknown>): boolean {
  return [args.from, args.to].some((ref) => typeof ref === 'string' && !!connectionEnd(ref).machineId);
}

async function manageRemote(callerId: string, scope: CallerScope, args: Record<string, unknown>, action: 'add' | 'remove' | 'tools'): Promise<McpToolResult> {
  const refs = [requireString(args, 'from'), requireString(args, 'to')];
  const ends = refs.map((ref) => {
    const address = connectionEnd(ref);
    if (address.machineId) {
      if (!isNetworkComputer(address.machineId)) throw new ConnectionScopeError('That computer is not in this Annex Network.');
      return address;
    }
    return { agentId: resolveAgent(scope, ref, 'agent').id };
  });
  if (ends.every((end) => !!end.machineId)) throw new ConnectionScopeError('One endpoint must be on this computer. Connections are not relayed between other computers.');
  if (ends[0].agentId === ends[1].agentId && ends[0].machineId === ends[1].machineId) throw new ConnectionScopeError('from and to must be different agents.');
  const machineId = annexIdentity.getIdentity()?.fingerprint?.toLowerCase();
  if (!machineId) throw new ConnectionScopeError('This computer has no Annex identity.');
  const twoWay = optionalBoolean(args, 'twoWay') ?? optionalBoolean(args, 'two_way') ?? false;
  const pairs = [{ from: ends[0], to: ends[1] }, ...(twoWay ? [{ from: ends[1], to: ends[0] }] : [])];
  const allow = readAllow(args, 'allow');
  if (action === 'tools' && !allow) throw new McpArgError('allow is required');
  const back = readAllow(args, 'allow_back') ?? allow;
  const allows = [allow, back];
  for (const [i, pair] of pairs.entries()) {
    const tools = allows[i];
    if (tools?.some((t) => t === 'clear_agent' || t === 'compact_agent')) {
      const receiver = pair.to.machineId
        ? remoteGrantTarget(callerId, pair.to)
        : agentGrantTarget(callerId, scope, resolveAgent(scope, pair.to.agentId, 'receiver'));
      if (!holdsGrant(callerId, 'agent.reset', receiver)) throw new ConnectionScopeError('Turning on clear_agent or compact_agent requires an allowed agent.reset grant on the receiver.');
    }
    if (action === 'add' && (isBindingRemovedByUser(bindingTargetOf(pair.from), bindingTargetOf(pair.to)) || isSourceRemovedByUser('network-agent-connections', bindingTargetOf(pair.from), bindingTargetOf(pair.to)))) {
      throw new ConnectionScopeError('The user removed this connection. Only the user can connect it again.');
    }
  }
  if (action === 'tools') {
    for (const machine of new Set(pairs.map((p) => p.from.machineId).filter((id): id is string => !!id))) {
      if (!await syncDirectionsWith(machine)) throw new ConnectionScopeError('The sender computer must be online to check who owns its switches.');
    }
    const { bySource, failed } = await collectSourcesByPair();
    if (failed.length) throw new ConnectionScopeError('Connection sources could not be checked. Try again.');
    for (const pair of pairs.filter((p) => !p.from.machineId)) {
      const key = `${bindingTargetOf(pair.from)}\u0000${bindingTargetOf(pair.to)}`;
      if ([...bySource].some(([id, keys]) => id !== 'network-agent-connections' && keys.has(key))) {
        throw new ConnectionScopeError('Another source also owns that direction. Ask the user to edit its tools in Connections.');
      }
    }
  }
  const disabled = allows.map((tools) => tools ? CONNECTION_SWITCHES.filter((s) => !tools.includes(s.tool)).map((s) => s.tool) : undefined);
  const result = await updateAgentNetworkLinks(pairs, { agentId: callerId, machineId, name: scope.caller.name }, action, disabled);
  await rebuildPersistedBindings();
  recordDispatcherControl({ tool: action === 'add' ? 'connect_agents' : action === 'remove' ? 'disconnect_agents' : 'set_connection_tools', actorId: callerId, targets: refs, outcome: 'ok' });
  return text(JSON.stringify({ connections: result.map((d) => ({ from: d.from, to: d.to, tools: { allowed: CONNECTION_SWITCHES.filter((s) => !d.disabledTools.includes(s.tool)).map((s) => s.tool), disabled: d.disabledTools }, made_by_agent: callerId })) }));
}

async function handleConnectAgents(callerId: string, args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const scope = await callerScope(callerId, true);
    if (isRemotePair(args)) return await manageRemote(callerId, scope, args, 'add');
    const { from, to, twoWay } = readPair(scope, args);
    const wires = [agentWire(scope, from, to), ...(twoWay ? [agentWire(scope, to, from)] : [])];
    const allow = readAllow(args, 'allow');
    const allowBack = readAllow(args, 'allow_back') ?? allow;
    for (const [i, wire] of wires.entries()) {
      const tools = i === 0 ? allow : allowBack;
      if (!tools) continue;
      assertResetGrant(callerId, scope, i === 0 ? to : from, tools);
      if (getConnectionDirection({ agentId: wire.agentId }, { agentId: wire.targetId })
        || bindingManager.getBindingsForAgent(wire.agentId).some((b) => b.targetId === wire.targetId)) {
        throw new ConnectionScopeError('Tools are already saved or another source connects that direction. Connect without allow to keep them, then edit only a direction you own.');
      }
    }
    const outcomes = await connect(callerId, scope, wires, [allow, allowBack]);
    const lines = wires.map((w, i) => {
      const label = `${w.agentName} → ${w.targetName}`;
      if (outcomes[i] === 'created') return `Connected ${label}.`;
      if (outcomes[i] === 'existing') return `${label} was already connected; the connection is now saved.`;
      if (outcomes[i] === 'removed') return `The user removed this connection (${label}).`;
      return `Could not connect ${label}.`;
    });
    recordDispatcherControl({ tool: 'connect_agents', actorId: callerId, targets: [from.id, to.id], outcome: outcomes.some((o) => o === 'invalid' || o === 'removed') ? 'refused' : 'ok' });
    return text([...lines, ...wires.map((w) => JSON.stringify({ from: { agentId: w.agentId }, to: { agentId: w.targetId }, tools: readLocalDirectionTools(w.agentId, w.targetId) }))].join('\n'), outcomes.some((o) => o === 'invalid' || o === 'removed'));
  } catch (err) {
    // telemetry-exempt: errorResult logs unexpected failures and returns them to the calling agent
    return errorResult('connect_agents', callerId, err, args);
  }
}

async function handleDisconnectAgents(callerId: string, args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const scope = await callerScope(callerId, true);
    if (isRemotePair(args)) return await manageRemote(callerId, scope, args, 'remove');
    const { from, to, twoWay } = readPair(scope, args);
    const pairs = [{ agentId: from.id, targetId: to.id, label: `${from.name} → ${to.name}` }];
    if (twoWay) pairs.push({ agentId: to.id, targetId: from.id, label: `${to.name} → ${from.name}` });
    const owned = (await readConnections(scope.projectPath)).filter((c) => c.ownerId === callerId);
    if (pairs.some((p) => bindingManager.getBindingsForAgent(p.agentId).some((b) => b.targetId === p.targetId)
      && !owned.some((c) => c.agentId === p.agentId && c.targetId === p.targetId))) {
      throw new ConnectionScopeError('You did not make that connection source. Canvas, user, helper and other agents’ sources cannot be removed here.');
    }
    const { outcomes } = await disconnect(callerId, scope, pairs);
    recordDispatcherControl({ tool: 'disconnect_agents', actorId: callerId, targets: [from.id, to.id], outcome: 'ok' });
    const lines = pairs.map((p, i) => {
      if (outcomes[i] === 'unbound') return `Disconnected ${p.label}.`;
      if (outcomes[i] === 'kept') return `${p.label}: removed the saved connection. ${STAYS_NOTE}`;
      return `${p.label} was not connected.`;
    });
    return text(lines.join('\n'));
  } catch (err) {
    // telemetry-exempt: errorResult logs unexpected failures and returns them to the calling agent
    return errorResult('disconnect_agents', callerId, err, args);
  }
}

function readAllow(args: Record<string, unknown>, key: string): string[] | undefined {
  if (args[key] === undefined) return undefined;
  const value = args[key];
  if (!Array.isArray(value) || value.some((t) => typeof t !== 'string' || !CONNECTION_SWITCHES.some((s) => s.tool === t))) {
    throw new McpArgError(`${key} must list connection tools: ${CONNECTION_SWITCHES.map((s) => s.tool).join(', ')}.`);
  }
  return [...new Set(value as string[])];
}

function agentGrantTarget(callerId: string, scope: CallerScope, receiver: DurableAgentConfig): GrantCallTarget {
  const relations: Array<'self' | 'my_helper' | 'connected'> = [];
  if (receiver.id === callerId) relations.push('self');
  if (scope.helperIds.has(receiver.id)) relations.push('my_helper');
  if (bindingManager.getBindingsForAgent(callerId).some((b) => b.targetKind === 'agent' && b.targetId === receiver.id)) relations.push('connected');
  return {
    kind: 'agent', relations, projectPath: scope.otherProjects.get(receiver.id) ?? scope.projectPath,
    isDispatcher: isTrackedDispatcher(receiver.id) || isDispatcherCoordinatorId(receiver.id),
  };
}

function remoteGrantTarget(callerId: string, end: { agentId: string; machineId?: string }): GrantCallTarget {
  const connected = bindingManager.getBindingsForAgent(callerId).some((b) => b.targetKind === 'agent' && b.targetId === bindingTargetOf(end));
  return { kind: 'agent', agentId: bindingTargetOf(end), relations: connected ? ['connected'] : [] };
}

function assertResetGrant(callerId: string, scope: CallerScope, receiver: DurableAgentConfig, allow: readonly string[]): void {
  if (!allow.some((tool) => tool === 'clear_agent' || tool === 'compact_agent')) return;
  if (!holdsGrant(callerId, 'agent.reset', agentGrantTarget(callerId, scope, receiver))) {
    throw new ConnectionScopeError('Turning on clear_agent or compact_agent requires an allowed agent.reset grant on the receiver. Ask the user to grant it first.');
  }
}

async function handleSetConnectionTools(callerId: string, args: Record<string, unknown>): Promise<McpToolResult> {
  let delegatedAudit = false;
  try {
    if (isDispatcherAgent(callerId) && !isRemotePair(args)) {
      const projectPath = getAgentProjectPath(callerId);
      const stored = projectPath ? (await readConnections(projectPath)).filter((c) => c.ownerId === callerId) : [];
      let own = false;
      if (stored.length > 0) {
        const pair = readPair(await callerScope(callerId, true), args);
        own = stored.some((c) => c.agentId === pair.from.id && c.targetId === pair.to.id);
      }
      if (!own) {
        const { twoWay, ...compat } = args;
        if (twoWay !== undefined) compat.two_way = optionalBoolean(args, 'twoWay');
        delegatedAudit = true;
        return text(JSON.stringify(await setConnectionToolsForLink(callerId, compat)));
      }
    }
    const scope = await callerScope(callerId, true);
    if (isRemotePair(args)) return await manageRemote(callerId, scope, args, 'tools');
    const { from, to, twoWay } = readPair(scope, args);
    const allow = readAllow(args, 'allow');
    if (!allow) throw new McpArgError('allow is required');
    const back = readAllow(args, 'allow_back') ?? allow;
    const pairs = [{ from, to, allow }, ...(twoWay ? [{ from: to, to: from, allow: back }] : [])];
    const stored = await readConnections(scope.projectPath);
    const owned = stored.filter((c) => c.ownerId === callerId);
    if (pairs.some((p) => !owned.some((c) => c.agentId === p.from.id && c.targetId === p.to.id && c.targetKind === 'agent'))) {
      throw new ConnectionScopeError('You did not make that connection, so you cannot change its tools.');
    }
    const { bySource, failed } = await collectSourcesByPair();
    if (failed.length > 0) throw new ConnectionScopeError('Connection ownership could not be read. Try again before changing its tools.');
    for (const p of pairs) {
      if ([...bySource].some(([id, keys]) => id !== ORCHESTRATOR_CONNECTION_SOURCE_ID && keys.has(`${p.from.id}\u0000${p.to.id}`))) {
        throw new ConnectionScopeError('Another source also owns that direction. Ask the user to edit its tools in Connections.');
      }
      assertResetGrant(callerId, scope, p.to, p.allow);
    }
    await setConnectionDirections(pairs.map((p) => ({
      from: { agentId: p.from.id }, to: { agentId: p.to.id }, ...localToolsFromAllow(p.allow),
    })), (current) => {
      if (current?.setByAgent !== callerId || current.link || current.cardLink) throw new ConnectionScopeError('The user owns those switches now. Ask them to edit the direction in Connections.');
    }, { agentId: callerId });
    recordDispatcherControl({ tool: 'set_connection_tools', actorId: callerId, targets: [from.id, to.id], outcome: 'ok' });
    return text(JSON.stringify({ connections: pairs.map((p) => ({ from: { agentId: p.from.id }, to: { agentId: p.to.id }, tools: readLocalDirectionTools(p.from.id, p.to.id) })) }));
  } catch (err) {
    // telemetry-exempt: unexpected failures are logged and surfaced by errorResult
    return errorResult('set_connection_tools', callerId, err, delegatedAudit ? undefined : args);
  }
}

async function handleListConnections(callerId: string, args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const scope = await callerScope(callerId, true);
    if (typeof args.agent === 'string' && connectionEnd(args.agent).machineId) {
      const target = connectionEnd(args.agent);
      if (!isNetworkComputer(target.machineId!)) throw new ConnectionScopeError('That computer is not in this Annex Network.');
      const same = (end: typeof target) => end.agentId === target.agentId && end.machineId === target.machineId;
      const connections = listAllConnectionDirections().filter((d) => (same(d.from) || same(d.to)) && (!!d.link || !!d.cardLink || !!activeAgentLinks(d).length)).map((d) => {
        const makers = activeAgentLinks(d);
        const owner = makers.find((l) => l.agentId === callerId && l.machineId === annexIdentity.getIdentity()?.fingerprint?.toLowerCase());
        const covered = [d.from, d.to].every((end) => {
          if (end.machineId) return holdsGrant(callerId, 'connection.manage', { kind: 'agent', relations: bindingManager.getBindingsForAgent(callerId).some((b) => b.targetId === bindingTargetOf(end)) ? ['connected'] : [] });
          const local = scope.agents.find((a) => a.id === end.agentId);
          return !!local && holdsGrant(callerId, 'connection.manage', agentGrantTarget(callerId, scope, local));
        });
        return { from: d.from, to: d.to, target_kind: 'agent', sources: [...(d.link ? ['network-connections'] : []), ...(d.cardLink ? ['connections-card'] : []), ...(makers.length ? ['network-agent-connections'] : [])],
          ...(makers[0] && { made_by_agent: makers[0].agentId, made_by_machine: makers[0].machineId }),
          tools: { allowed: CONNECTION_SWITCHES.filter((s) => !d.disabledTools.includes(s.tool)).map((s) => s.tool), disabled: CONNECTION_SWITCHES.filter((s) => d.disabledTools.includes(s.tool)).map((s) => s.tool) },
          may_change: !!owner && makers.length === 1 && !d.link && !d.cardLink && d.setByAgent === callerId && (!d.from.machineId || d.agentToolsProtected === false) && covered };
      });
      return text(JSON.stringify({ connections, unreadable: [] }));
    }
    const agent = args.agent === undefined ? scope.caller : resolveAgent(scope, requireString(args, 'agent'), 'agent');
    const stored = await readConnections(scope.projectPath);
    const owned = stored.filter((c) => c.ownerId === callerId);
    const { bySource, failed } = await collectSourcesByPair();
    const bindings = bindingManager.getAllBindings().filter((b) => b.agentId === agent.id || (b.targetKind === 'agent' && b.targetId === agent.id));
    const connections = bindings.map((b) => {
      const key = `${b.agentId}\u0000${b.targetId}`;
      const sources = [...bySource].filter(([, keys]) => keys.has(key)).map(([id]) => id);
      const managedEnds = [b.agentId, b.targetId].map((id) => scope.agents.find((a) => a.id === id));
      const creator = stored.find((c) => c.agentId === b.agentId && c.targetId === b.targetId)?.ownerId;
      const from = connectionEnd(b.agentId);
      const to = connectionEnd(b.targetId);
      const direction = b.targetKind === 'agent' ? getConnectionDirection(from, to) : undefined;
      const makers = activeAgentLinks(direction);
      const disabled = direction?.disabledTools ?? b.disabledTools ?? [];
      const tools = from.machineId || to.machineId
        ? {
          allowed: CONNECTION_SWITCHES.filter((s) => !disabled.includes(s.tool)).map((s) => s.tool),
          disabled: CONNECTION_SWITCHES.filter((s) => disabled.includes(s.tool)).map((s) => s.tool),
        }
        : readLocalDirectionTools(b.agentId, b.targetId);
      return {
        from, to, target_kind: b.targetKind, sources,
        ...((creator || makers[0]) && { made_by_agent: creator ?? makers[0].agentId }),
        ...(makers[0] && { made_by_machine: makers[0].machineId }),
        ...(b.targetKind === 'agent' && { tools }),
        may_change: !!(to.machineId && makers.length === 1 && makers[0].agentId === callerId && makers[0].machineId === annexIdentity.getIdentity()?.fingerprint?.toLowerCase() && !direction.link && !direction.cardLink && direction.setByAgent === callerId && holdsGrant(callerId, 'connection.manage', remoteGrantTarget(callerId, to)) && managedEnds[0] && holdsGrant(callerId, 'connection.manage', agentGrantTarget(callerId, scope, managedEnds[0]))) || b.targetKind === 'agent' && failed.length === 0 && direction?.setByAgent === callerId && !direction.link && !direction.cardLink
          && managedEnds.every((end) => end && holdsGrant(callerId, 'connection.manage', agentGrantTarget(callerId, scope, end)))
          && sources.length === 1 && sources[0] === ORCHESTRATOR_CONNECTION_SOURCE_ID
          && owned.some((c) => c.agentId === b.agentId && c.targetId === b.targetId),
      };
    });
    // The incoming network direction is held by the remote sender, so it has no local binding.
    for (const d of listAllConnectionDirections().filter((x) => !!x.from.machineId && !x.to.machineId && x.to.agentId === agent.id && (!!x.link || !!x.cardLink || !!activeAgentLinks(x).length))) {
      const makers = activeAgentLinks(d);
      const ownedLink = makers.find((l) => l.agentId === callerId && l.machineId === annexIdentity.getIdentity()?.fingerprint?.toLowerCase());
      connections.push({
        from: d.from, to: d.to, target_kind: 'agent', sources: [...(d.link ? ['network-connections'] : []), ...(d.cardLink ? ['connections-card'] : []), ...(makers.length ? ['network-agent-connections'] : [])],
        ...(makers[0] && { made_by_agent: makers[0].agentId, made_by_machine: makers[0].machineId }),
        tools: { allowed: CONNECTION_SWITCHES.filter((s) => !d.disabledTools.includes(s.tool)).map((s) => s.tool), disabled: CONNECTION_SWITCHES.filter((s) => d.disabledTools.includes(s.tool)).map((s) => s.tool) },
        may_change: !!ownedLink && !d.link && !d.cardLink && makers.length === 1 && d.setByAgent === callerId && d.agentToolsProtected === false
          && holdsGrant(callerId, 'connection.manage', remoteGrantTarget(callerId, d.from))
          && holdsGrant(callerId, 'connection.manage', agentGrantTarget(callerId, scope, agent)),
      });
    }
    return text(JSON.stringify({ connections, unreadable: failed }));
  } catch (err) {
    // telemetry-exempt: unexpected failures are logged and surfaced by errorResult
    return errorResult('list_connections', callerId, err);
  }
}

const AGENT_REF = 'An agent name or id: you or one of your helpers.';
const CONNECTION_AGENT_REF = 'Your id, a registered durable agent or Dispatcher id or unique name, or an agentId@machine address in this Annex Network. Requires connection.manage on the named agent.';
const PROJECT_REF = 'A group project name or id: one you created with create_group_project or already belong to.';

/** Register the orchestrator connection tools. */
export function registerConnectionTools(): void {
  const options = { group: 'orchestration' as const };
  const connectionOptions = { group: 'connections' as const };

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
  }, handleCreateGroupProject, { ...options, grant: { actions: ['connection.manage'], target: 'agent_arg', from: { args: ['members'], names: 'self_and_helpers' } } });

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
  }, handleAddToGroupProject, { ...options, grant: { actions: ['connection.manage'], target: 'agent_arg', from: { args: ['helper'], names: 'self_and_helpers' } } });

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
  }, handleRemoveFromGroupProject, { ...options, grant: { actions: ['connection.manage'], target: 'agent_arg', from: { args: ['helper'], names: 'self_and_helpers' } } });

  const membershipGrant = [
    { actions: ['connection.manage'] as const, target: 'agent_arg' as const, strictTargets: true, from: { args: ['agent'], names: 'registered' as const } },
    { actions: ['connection.manage'] as const, target: 'group_project_arg' as const, from: { args: ['project'] } },
  ];
  const membershipSchema = { type: 'object' as const, properties: {
    project: { type: 'string', description: 'Group project name or id.' },
    agent: { type: 'string', description: 'A local durable agent or Dispatcher id or unique name.' },
  }, required: ['project', 'agent'] };
  registerGlobalTool('join_group_project', {
    description: 'Add an agent you may manage to a group project you may manage.', inputSchema: membershipSchema,
  }, (caller, args) => handleAddToGroupProject(caller, args, true), { ...connectionOptions, grant: membershipGrant });
  registerGlobalTool('leave_group_project', {
    description: 'Remove a membership source you made for an agent and group project you may manage.', inputSchema: membershipSchema,
  }, (caller, args) => handleRemoveFromGroupProject(caller, args, true), { ...connectionOptions, grant: membershipGrant });

  registerGlobalTool('connect_agents', {
    description:
      'Connect two agents covered by your connection.manage grants. ' +
      'New directions allow status, output, reachability, messages, files and wake; clear and compact stay off. ' +
      'Set twoWay to connect both directions. Each direction is saved and read back; existing switches are kept.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: CONNECTION_AGENT_REF },
        to: { type: 'string', description: CONNECTION_AGENT_REF },
        twoWay: { type: 'boolean', description: 'Also connect `to` back to `from`. Default false.' },
        allow: { type: 'array', items: { type: 'string', enum: CONNECTION_SWITCHES.map((s) => s.tool) }, description: 'Optional tools to allow on a new outgoing direction. Reset tools require your agent.reset grant on the receiver.' },
        allow_back: { type: 'array', items: { type: 'string', enum: CONNECTION_SWITCHES.map((s) => s.tool) }, description: 'Optional tools for the reverse direction; defaults to allow when given.' },
      },
      required: ['from', 'to'],
    },
  }, handleConnectAgents, { ...connectionOptions, grant: { actions: ['connection.manage'], target: 'agent_arg', allowRemote: true, from: { args: ['from', 'to'], names: 'registered' } } });

  registerGlobalTool('disconnect_agents', {
    description:
      'Remove a connection made with connect_agents. Set twoWay to remove both directions. ' +
      'Connections drawn on the canvas, and the link between you and your helpers, stay.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: CONNECTION_AGENT_REF },
        to: { type: 'string', description: CONNECTION_AGENT_REF },
        twoWay: { type: 'boolean', description: 'Also remove `to` → `from`. Default false.' },
      },
      required: ['from', 'to'],
    },
  }, handleDisconnectAgents, { ...connectionOptions, grant: { actions: ['connection.manage'], target: 'agent_arg', allowRemote: true, from: { args: ['from', 'to'], names: 'registered' } } });

  registerGlobalTool('set_connection_tools', {
    description: 'Set one direction of a connection you made. Other sources and directions stay unchanged. Returns saved switches. Reset tools require your agent.reset grant on the receiver. Dispatcher-owned links keep their existing ownership rules.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: CONNECTION_AGENT_REF },
        to: { type: 'string', description: CONNECTION_AGENT_REF },
        allow: { type: 'array', items: { type: 'string', enum: CONNECTION_SWITCHES.map((s) => s.tool) } },
        twoWay: { type: 'boolean', description: 'Also set the reverse direction. Default false.' },
        two_way: { type: 'boolean', description: 'Compatibility spelling of twoWay for Dispatcher links.' },
        allow_back: { type: 'array', items: { type: 'string', enum: CONNECTION_SWITCHES.map((s) => s.tool) } },
      },
      required: ['from', 'to', 'allow'],
    },
  }, handleSetConnectionTools, { ...connectionOptions, grant: { actions: ['connection.manage'], target: 'agent_arg', allowRemote: true, from: { args: ['from', 'to'], names: 'registered' } } });

  registerGlobalTool('list_connections', {
    description: 'Read your saved connections, their sources, switches and whether you may change each direction. Naming another agent, including an address on a network computer, requires connection.manage on it.',
    inputSchema: { type: 'object', properties: { agent: { type: 'string', description: CONNECTION_AGENT_REF } } },
  }, handleListConnections, { ...connectionOptions, grant: { actions: ['connection.manage'], target: 'agent_arg', allowRemote: true, from: { args: ['agent'], names: 'registered', missing: 'caller' } } });
}
