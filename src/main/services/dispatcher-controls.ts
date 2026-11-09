/**
 * The rules of the Dispatcher's controls over connected orchestrators (#2661):
 * their cross-project helper switch and helper cap, and direct links between
 * them. The MCP tools only turn arguments and refusals into results.
 *
 * Only the running Dispatcher, and only for agents that are connected
 * orchestrators now. Nothing here can turn orchestration off, change Connect to
 * Dispatcher, or touch a user-created link or the Dispatcher's own wires:
 * patches are built from two fields, and disconnect only acts on pairs in the
 * Dispatcher's store. Settings go through setOrchestrationPolicy, so its lock,
 * checks and gate handling all apply. Neither setting stops or settles a helper.
 *
 * Every write call that reaches here leaves an audit row, refusals included.
 * What the registry refuses never gets here (its group gate, and its check of an
 * argument's type): that shows only in the tool-call telemetry.
 */

import { isDispatcherAgent } from './clubhouse-mcp/dispatcher-gate';
import { bindingManager } from './clubhouse-mcp/binding-manager';
import { auditNames, auditString, readDispatcherControls, recordDispatcherControl, type AuditRow, type AuditValue } from '../telemetry/dispatcher-telemetry';
import {
  DISPATCHER_CONNECTION_SOURCE_ID,
  DispatcherLinkRefused,
  MAX_DISPATCHER_LINKS,
  addDispatcherConnections,
  bindingFor,
  isConnectedOrchestrator,
  isTombstoned,
  listPendingRemovals,
  readAgentCensus,
  readDispatcherConnections,
  recordUserRemoval,
  removeDispatcherConnections,
  statusOf,
  suspensionOf,
  type AgentCensus,
  type DispatcherConnection,
  type OrchestratorEntry,
} from './dispatcher-connections';
import { isDispatcherIdentityAgentId as isDispatcherAgentId, isDispatcherEnabled } from './dispatcher/dispatcher-service';
import { listHelpersEverywhere } from './helper-index';
import { getHelperSummary, setOrchestrationPolicy } from './orchestration-policy';
import * as orchestrationSettings from './orchestration-settings';
import {
  claimSourceBinding,
  collectSourcesByPair,
  isBindingRemovedByUser,
  persistedPairKey,
  listSoleOwnedPairs,
  rebuildPersistedBindings,
  releaseSourceBinding,
} from './persisted-bindings';
import { isDisposedAgent } from '../../shared/agent-helpers';
import { appLog } from './log-service';
import { CONNECTION_SWITCHES, NEW_CONNECTION_DISABLED_TOOLS, localToolsFromAllow, type DirectionTools } from '../../shared/connection-grants';
import { connectionMigrationDone, getConnectionDirection, runConnectionMigration, setConnectionDirections, type DirectionToolsChange } from './connection-grants-store';
import { connectionFileIsNewer, forgetDispatcherDirection, readLocalDirectionTools } from './connection-grants';
import { maxHelpersCeiling } from '../../shared/orchestration-policy';

export type ControlRefusal =
  | 'not_dispatcher'
  | 'invalid_args'
  | 'unknown_field'
  | 'dispatcher_wire'
  | 'helper'
  | 'not_connected_orchestrator'
  | 'not_dispatcher_owned'
  | 'already_linked'
  | 'removed_by_user'
  | 'max_helpers_out_of_range'
  | 'link_limit'
  | 'policy_refused'
  | 'user_tools';

export class DispatcherControlError extends Error {
  constructor(readonly code: ControlRefusal, message: string) {
    super(message);
    this.name = 'DispatcherControlError';
  }
}

export const DEFAULT_CONTROLS_PAGE = 10;
export const MAX_CONTROLS_PAGE = 25;

const AUDIT_FAILED = 'The change was made, but local telemetry recording is off, so it is not in the audit record.';

/** Run one tool call, leaving its audit row whatever happens. */
async function audited<T extends object>(
  row: Pick<AuditRow, 'tool' | 'actorId' | 'targets' | 'requested'>,
  run: () => Promise<{ result: T; before?: Record<string, AuditValue>; after?: Record<string, AuditValue>; code?: string }>,
): Promise<T & { audit_warning?: string }> {
  try {
    if (!isDispatcherAgent(row.actorId)) throw new DispatcherControlError('not_dispatcher', 'Only the Dispatcher can do this.');
    const { result, before, after, code } = await run();
    const written = recordDispatcherControl({ ...row, outcome: 'ok', ...(before && { before }), ...(after && { after }), ...(code && { code }) });
    return written ? result : { ...result, audit_warning: AUDIT_FAILED };
  } catch (err) {
    const refusal = err instanceof DispatcherControlError ? err.code : undefined;
    recordDispatcherControl({ ...row, outcome: refusal ? 'refused' : 'error', ...(refusal && { code: refusal }) });
    throw err;
  }
}

function assertOnly(args: Record<string, unknown>, allowed: readonly string[], forbiddenNote: string): void {
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new DispatcherControlError('unknown_field', `This tool doesn't take ${unknown.join(', ')}. It takes only: ${allowed.join(', ')}. ${forbiddenNote}`);
  }
}

function requireId(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) throw new DispatcherControlError('invalid_args', `${key} must be an agent id from list_agents.`);
  return value.trim();
}

function optionalFlag(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new DispatcherControlError('invalid_args', `${key} must be true or false.`);
  return value;
}

/** The connected orchestrator with this id, or the refusal that says why it isn't one. */
function requireOrchestrator(census: AgentCensus, id: string): OrchestratorEntry {
  if (isDispatcherAgentId(id)) {
    throw new DispatcherControlError('dispatcher_wire', 'That is you. These tools can\'t change your own settings or wires.');
  }
  const entry = census.agents.get(id);
  if (!entry || isDisposedAgent(entry.agent)) {
    throw new DispatcherControlError('not_connected_orchestrator', `"${auditString(id)}" is not a connected orchestrator. Call list_agents for the ids.`);
  }
  if (entry.agent.parentAgentId) {
    throw new DispatcherControlError('helper', `${entry.agent.name} is a helper. Helpers belong to their parent, so these tools can't target one.`);
  }
  if (!isConnectedOrchestrator(entry.agent, entry.policy)) {
    throw new DispatcherControlError('not_connected_orchestrator', `${entry.agent.name} is not a connected orchestrator. Only the user can turn that on.`);
  }
  return entry;
}

// ── Settings ─────────────────────────────────────────────────────────────

const SET_FIELDS = ['agent_id', 'cross_project_helpers', 'max_helpers'] as const;
const SET_NOTE = 'Turning orchestration off, disconnecting an agent from you, and access or approval settings are the user\'s.';

export async function setOrchestratorHelpers(actorId: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const known = Object.keys(args).filter((key) => key !== 'agent_id');
  return audited({
    tool: 'set_orchestrator_helpers',
    actorId,
    targets: typeof args.agent_id === 'string' ? [auditString(args.agent_id)] : [],
    requested: {
      fields: auditNames(known),
      ...(typeof args.cross_project_helpers === 'boolean' && { cross_project_helpers: args.cross_project_helpers }),
      ...(typeof args.max_helpers === 'number' && { max_helpers: args.max_helpers }),
    },
  }, async () => {
    assertOnly(args, SET_FIELDS, SET_NOTE);
    const agentId = requireId(args, 'agent_id');
    const crossProjectHelpers = optionalFlag(args, 'cross_project_helpers');
    const maxHelpers = args.max_helpers;
    if (crossProjectHelpers === undefined && maxHelpers === undefined) {
      throw new DispatcherControlError('invalid_args', 'Set cross_project_helpers, max_helpers, or both.');
    }
    const globalCap = orchestrationSettings.getGlobalHelperCap();
    const ceiling = maxHelpersCeiling(globalCap);
    if (maxHelpers !== undefined && (typeof maxHelpers !== 'number' || !Number.isInteger(maxHelpers) || maxHelpers < 1 || maxHelpers > ceiling)) {
      throw new DispatcherControlError('max_helpers_out_of_range', `max_helpers must be a whole number from 1 to ${ceiling}. The app-wide cap is ${globalCap}.`);
    }
    const census = await readAgentCensus();
    const target = requireOrchestrator(census, agentId);

    let before: Record<string, AuditValue> = {};
    const outcome = await setOrchestrationPolicy(target.projectPath, agentId, {
      ...(crossProjectHelpers !== undefined && { crossProjectHelpers }),
      ...(maxHelpers !== undefined && { maxHelpers: maxHelpers as number }),
    }, {
      surface: 'dispatcher',
      actorId,
      // Checked again under the agent's lock: the user may have just changed it.
      precondition: (agent, current) => {
        if (!isConnectedOrchestrator(agent, current)) {
          throw new DispatcherControlError('not_connected_orchestrator', `${agent.name} is not a connected orchestrator any more.`);
        }
        before = { crossProjectHelpers: current.crossProjectHelpers, maxHelpers: current.maxHelpers };
      },
    });
    if (!outcome.ok || !outcome.policy) throw new DispatcherControlError('policy_refused', outcome.message);

    const { policy } = outcome;
    const { helperIds } = await getHelperSummary(target.projectPath, agentId);
    const helpersOverCap = Math.max(0, helperIds.length - policy.maxHelpers);
    return {
      before,
      after: { crossProjectHelpers: policy.crossProjectHelpers, maxHelpers: policy.maxHelpers },
      result: {
        id: agentId,
        name: target.agent.name,
        cross_project_helpers: policy.crossProjectHelpers,
        max_helpers: policy.maxHelpers,
        live_helpers: helperIds.length,
        global_cap: globalCap,
        // Nothing stops: new starts are refused until the count drops.
        ...(helpersOverCap > 0 && { helpersOverCap }),
        ...(outcome.crossProjectHelpersKept && { crossProjectHelpersKept: outcome.crossProjectHelpersKept }),
      },
    };
  });
}

// ── Links ────────────────────────────────────────────────────────────────

const LINK_FIELDS = ['from', 'to', 'two_way'] as const;
/** connect_orchestrators and set_connection_tools also take the tools to allow on each direction (#3215). */
const TOOL_LINK_FIELDS = ['from', 'to', 'two_way', 'allow', 'allow_back'] as const;
const LINK_NOTE = 'Links the user made and your own wires can\'t be changed here.';

/** The tool names a direction's `allow` takes: the connection tools and wake (#3215). */
export const CONNECTION_SWITCH_NAMES: readonly string[] = CONNECTION_SWITCHES.map((t) => t.tool);

interface Pair { agentId: string; targetId: string }

interface LinkRequest {
  from: string;
  to: string;
  pairs: Pair[];
  /** For each pair, in order: the tools to allow on it, when the call names them. */
  allow: Array<string[] | undefined>;
}

function readAllow(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  const names = `It takes tool names from: ${CONNECTION_SWITCH_NAMES.join(', ')}.`;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new DispatcherControlError('invalid_args', `${key} must be a list of tool names. ${names}`);
  }
  const unknown = value.filter((v) => !CONNECTION_SWITCH_NAMES.includes(v));
  if (unknown.length > 0) {
    throw new DispatcherControlError('invalid_args', `${key} has ${unknown.map(auditString).join(', ')}, which a connection doesn't carry. ${names} Sleep, provider changes and other control stay yours.`);
  }
  return [...new Set(value as string[])];
}

function readLinkRequest(args: Record<string, unknown>, fields: readonly string[] = LINK_FIELDS): LinkRequest {
  assertOnly(args, fields, LINK_NOTE);
  const from = requireId(args, 'from');
  const to = requireId(args, 'to');
  if (from === to) throw new DispatcherControlError('invalid_args', 'from and to must be different agents.');
  const twoWay = optionalFlag(args, 'two_way') ?? false;
  if (isDispatcherAgentId(from) || isDispatcherAgentId(to)) {
    throw new DispatcherControlError('dispatcher_wire', 'That is one of your own wires. Those follow the agent\'s Connect to Dispatcher setting, which is the user\'s.');
  }
  const allow = readAllow(args, 'allow');
  const allowBack = readAllow(args, 'allow_back');
  if (allowBack && !twoWay) throw new DispatcherControlError('invalid_args', 'allow_back is for the way back, so it needs two_way.');
  return {
    from, to,
    pairs: [{ agentId: from, targetId: to }, ...(twoWay ? [{ agentId: to, targetId: from }] : [])],
    // The way back takes allow_back, else the same tools as the way there.
    allow: [allow, ...(twoWay ? [allowBack ?? allow] : [])],
  };
}

function linkRow(tool: string, actorId: string, args: Record<string, unknown>): Pick<AuditRow, 'tool' | 'actorId' | 'targets' | 'requested'> {
  const toolList = (key: string) => (Array.isArray(args[key]) ? { [key]: auditNames((args[key] as unknown[]).map(auditString)) } : {});
  return {
    tool,
    actorId,
    targets: [args.from, args.to].filter((v): v is string => typeof v === 'string').map(auditString),
    requested: {
      fields: auditNames(Object.keys(args)), ...(typeof args.two_way === 'boolean' && { two_way: args.two_way }),
      ...toolList('allow'), ...toolList('allow_back'),
    },
  };
}

const isBound = (pair: Pair) =>
  bindingManager.getBindingsForAgent(pair.agentId).some((b) => b.targetId === pair.targetId);

const pairLabel = (a: OrchestratorEntry, b: OrchestratorEntry) => `${a.agent.name} → ${b.agent.name}`;

const local = (agentId: string) => ({ agentId });

/**
 * Whether the tools on one of the Dispatcher's links are its to set (#3215):
 * nothing else binds the pair (a canvas wire, the user's link), and the user
 * set no tools on it. A direction with no tools saved yet counts as its own.
 */
function toolsAreOurs(pair: Pair): boolean {
  const entry = getConnectionDirection(local(pair.agentId), local(pair.targetId));
  if (entry?.link || (entry && entry.setBy !== 'dispatcher')) return false;
  return !isBound(pair) || listSoleOwnedPairs(DISPATCHER_CONNECTION_SOURCE_ID).some((p) => p.agentId === pair.agentId && p.targetId === pair.targetId);
}

/** One direction read back: what its sender may use, and whether the tools are still the Dispatcher's to change. */
function directionReadback(pair: Pair): { tools: DirectionTools; tools_yours: boolean } {
  return { tools: readLocalDirectionTools(pair.agentId, pair.targetId), tools_yours: toolsAreOurs(pair) };
}

/**
 * Save the Dispatcher's tools on its directions in one write: the ones it
 * named, else what a new connection starts with. Who owns each direction is
 * checked again under the store's lock, so a switch the user turned since the
 * caller looked refuses the whole write (`user_tools`) and nothing changes.
 */
async function writeDirectionTools(writes: ReadonlyArray<{ pair: Pair; allow?: readonly string[]; label: string }>): Promise<void> {
  if (writes.length === 0) return;
  const labels = new Map<string, string>();
  const changes = writes.map(({ pair, allow, label }): DirectionToolsChange => {
    labels.set(`${pair.agentId}>${pair.targetId}`, label);
    const { disabledTools, enabledTools } = allow
      ? localToolsFromAllow(allow)
      : { disabledTools: [...NEW_CONNECTION_DISABLED_TOOLS], enabledTools: [] };
    return { from: local(pair.agentId), to: local(pair.targetId), disabledTools, enabledTools };
  });
  await setConnectionDirections(changes, (current, change) => {
    if (current && (current.link || current.setBy !== 'dispatcher')) {
      throw userToolsRefusal(labels.get(`${change.from.agentId}>${change.to.agentId}`) ?? `${change.from.agentId} → ${change.to.agentId}`);
    }
  });
}

function userToolsRefusal(label: string): DispatcherControlError {
  return new DispatcherControlError('user_tools', `The user set the tools on ${label}, or connects it another way too, so they stay theirs. Nothing changed. Ask the user to change them on the Connections card.`);
}

export async function connectOrchestrators(actorId: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return audited(linkRow('connect_orchestrators', actorId, args), async () => {
    const { from, to, pairs, allow } = readLinkRequest(args, TOOL_LINK_FIELDS);
    const census = await readAgentCensus();
    const ends = new Map([[from, requireOrchestrator(census, from)], [to, requireOrchestrator(census, to)]]);
    const stored = await readDispatcherConnections();
    const isOurs = (p: { agentId: string; targetId: string }) => stored.some((c) => c.agentId === p.agentId && c.targetId === p.targetId);

    // All checked first: a refusal for one direction changes neither.
    for (const pair of pairs) {
      const label = pairLabel(ends.get(pair.agentId)!, ends.get(pair.targetId)!);
      if (isBindingRemovedByUser(pair.agentId, pair.targetId) || await isTombstoned(pair)) {
        throw new DispatcherControlError('removed_by_user', `The user removed ${label}. It stays removed until the user draws it again.`);
      }
      if (!isOurs(pair) && isBound(pair)) {
        throw new DispatcherControlError('already_linked', `${label} is already connected, and you didn't make it, so it stays the user's.`);
      }
    }
    // The tools on each direction (#3215): a new link starts like any new connection (no clear, compact or
    // wake) unless the call names its tools. Tools the user saved are never changed: naming them is refused.
    const writes: Array<{ pair: Pair; allow?: string[]; label: string }> = [];
    for (const [i, pair] of pairs.entries()) {
      const label = pairLabel(ends.get(pair.agentId)!, ends.get(pair.targetId)!);
      const entry = getConnectionDirection(local(pair.agentId), local(pair.targetId));
      const usersTools = !!entry && (entry.setBy !== 'dispatcher' || !!entry.link);
      if (isOurs(pair) ? !toolsAreOurs(pair) : usersTools) {
        if (allow[i]) throw userToolsRefusal(label);
        continue;
      }
      // A link it made already keeps its tools unless the call names new ones; one without any saved gets the defaults.
      if (isOurs(pair) && entry && !allow[i]) continue;
      writes.push({ pair, allow: allow[i], label });
    }

    const createdAt = new Date().toISOString();
    const entries: DispatcherConnection[] = pairs.map((p) => ({
      agentId: p.agentId,
      targetId: p.targetId,
      agentProjectPath: ends.get(p.agentId)!.projectPath,
      targetProjectPath: ends.get(p.targetId)!.projectPath,
      createdAt,
      createdBy: actorId,
    }));
    let added: DispatcherConnection[];
    try {
      added = await addDispatcherConnections(entries);
    } catch (err) {
      if (err instanceof DispatcherLinkRefused) throw new DispatcherControlError(err.code, err.message);
      throw err;
    }
    // Saved before binding, so the link has its tools from the moment it exists.
    try {
      await writeDirectionTools(writes);
    } catch (err) {
      // The user saved tools on a direction since the check above: the link isn't made.
      await removeDispatcherConnections(added);
      throw err;
    }

    const outcomes = pairs.map((p) => claimSourceBinding(DISPATCHER_CONNECTION_SOURCE_ID, bindingFor(ends.get(p.agentId)!, ends.get(p.targetId)!)));
    // The user removed a pair between the check above and the claim: don't keep it.
    if (outcomes.includes('removed')) {
      // Only what this call added: a link it found already saved was there before it.
      // The removed direction goes first and fails closed, so a failed write can't leave it to restore.
      const wasRemoved = (p: { agentId: string; targetId: string }) => isBindingRemovedByUser(p.agentId, p.targetId);
      for (const p of added.filter(wasRemoved)) await recordUserRemoval(p);
      await removeDispatcherConnections(added.filter((p) => !wasRemoved(p)));
      for (const p of added) releaseSourceBinding(DISPATCHER_CONNECTION_SOURCE_ID, p.agentId, p.targetId);
      await rebuildPersistedBindings();
      for (const w of writes) await forgetDispatcherDirection(w.pair.agentId, w.pair.targetId);
      throw new DispatcherControlError('removed_by_user', 'The user removed this connection. It stays removed until the user draws it again.');
    }
    await rebuildPersistedBindings();
    return {
      code: outcomes.join(','),
      result: {
        links: pairs.map((p, i) => ({
          from: p.agentId, to: p.targetId, label: pairLabel(ends.get(p.agentId)!, ends.get(p.targetId)!), outcome: outcomes[i],
          ...directionReadback(p),
        })),
      },
    };
  });
}

export async function disconnectOrchestrators(actorId: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return audited(linkRow('disconnect_orchestrators', actorId, args), async () => {
    const { pairs } = readLinkRequest(args);
    const stored = await readDispatcherConnections();
    const notOurs = pairs.find((p) => !stored.some((c) => c.agentId === p.agentId && c.targetId === p.targetId));
    if (notOurs) {
      throw new DispatcherControlError('not_dispatcher_owned', `You didn't make the link from "${auditString(notOurs.agentId)}" to "${auditString(notOurs.targetId)}", so it can't be removed here. Nothing changed.`);
    }
    await removeDispatcherConnections(pairs);
    // Only unbinds what this source owns: a wire the user also drew stays.
    const outcomes = pairs.map((p) => releaseSourceBinding(DISPATCHER_CONNECTION_SOURCE_ID, p.agentId, p.targetId));
    await rebuildPersistedBindings();
    // The tools it set go with the link once nothing binds the pair, so a wire the user draws later starts fresh (#3215).
    for (const p of pairs) await forgetDispatcherDirection(p.agentId, p.targetId);
    return {
      code: outcomes.join(','),
      result: { links: pairs.map((p, i) => ({ from: p.agentId, to: p.targetId, outcome: outcomes[i] })) },
    };
  });
}

/**
 * Set the tools on links the Dispatcher made (#3215): each direction named
 * gets exactly the tools in its `allow` (the connection tools and wake). A
 * direction the user set tools on, or connects another way too, is refused,
 * and nothing changes. Returns every direction read back.
 */
export async function setConnectionToolsForLink(actorId: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return audited(linkRow('set_connection_tools', actorId, args), async () => {
    const { pairs, allow } = readLinkRequest(args, TOOL_LINK_FIELDS);
    if (allow.some((a) => !a)) throw new DispatcherControlError('invalid_args', 'Set allow: the tools the link may use. An empty list turns them all off.');
    const stored = await readDispatcherConnections();
    const census = await readAgentCensus();
    const nameOf = (id: string) => census.agents.get(id)?.agent.name ?? auditString(id);
    // All checked first: a refusal for one direction changes neither.
    for (const pair of pairs) {
      const isOurs = stored.some((c) => c.agentId === pair.agentId && c.targetId === pair.targetId);
      if (!isOurs) {
        throw new DispatcherControlError('not_dispatcher_owned', `You didn't make the link from "${auditString(pair.agentId)}" to "${auditString(pair.targetId)}", so its tools can't be changed here. Nothing changed.`);
      }
      if (!toolsAreOurs(pair)) throw userToolsRefusal(`${nameOf(pair.agentId)} → ${nameOf(pair.targetId)}`);
    }
    const before = Object.fromEntries(pairs.map((p) => [`${auditString(p.agentId)}>${auditString(p.targetId)}`, readLocalDirectionTools(p.agentId, p.targetId).allowed.join(',')]));
    await writeDirectionTools(pairs.map((pair, i) => ({ pair, allow: allow[i], label: `${nameOf(pair.agentId)} → ${nameOf(pair.targetId)}` })));
    const links = pairs.map((p) => ({ from: p.agentId, to: p.targetId, label: `${nameOf(p.agentId)} → ${nameOf(p.targetId)}`, ...directionReadback(p) }));
    return {
      before,
      after: Object.fromEntries(links.map((l) => [`${auditString(l.from)}>${auditString(l.to)}`, l.tools.allowed.join(',')])),
      result: { links },
    };
  });
}

// ── Links made before #3215 ──────────────────────────────────────────────

/** The done marker of the one-time change below, in connection-grants.json. */
export const DISPATCHER_LINK_DEFAULTS_MIGRATION = 'dispatcher-link-defaults-3215';

let deferralLogged = false;

/**
 * Once, at startup: links the Dispatcher made before #3215 have no saved
 * tools, so every tool was on. Each one that is still only the Dispatcher's
 * (in its store, no other source lists the pair, nothing saved for the
 * direction) gets what a new link starts with: clear, compact and wake off,
 * marked as the Dispatcher's. A direction with saved tools and any pair the
 * user connects too are never touched. Waits for a later rebuild while a
 * source can't be read, since it might list the pair.
 */
export async function migrateDispatcherLinkTools(): Promise<'done' | 'already' | 'deferred'> {
  if (connectionMigrationDone(DISPATCHER_LINK_DEFAULTS_MIGRATION)) return 'already';
  // A newer build's file: said once (connectionFileIsNewer), not on every rebuild.
  if (connectionFileIsNewer()) return 'deferred';
  const { bySource, failed } = await collectSourcesByPair();
  if (failed.length > 0) {
    if (!deferralLogged) {
      deferralLogged = true;
      appLog('core:mcp', 'info', 'Dispatcher link defaults wait: a connection source could not be read', { meta: { failed } });
    }
    return 'deferred';
  }
  const listedElsewhere = (p: Pair) => [...bySource].some(([id, keys]) => id !== DISPATCHER_CONNECTION_SOURCE_ID && keys.has(persistedPairKey(p.agentId, p.targetId)));
  const now = new Date().toISOString();
  const directions = (await readDispatcherConnections())
    .filter((c) => !getConnectionDirection(local(c.agentId), local(c.targetId)) && !listedElsewhere(c) && !isBindingRemovedByUser(c.agentId, c.targetId))
    .map((c) => ({
      from: local(c.agentId), to: local(c.targetId),
      disabledTools: [...NEW_CONNECTION_DISABLED_TOOLS], setBy: 'dispatcher' as const, updatedAt: now,
    }));
  const written = await runConnectionMigration(DISPATCHER_LINK_DEFAULTS_MIGRATION, directions);
  if (written === null) return 'already';
  appLog('core:mcp', 'info', 'Dispatcher links made before #3215 now start like new links: clear, compact and wake off', {
    meta: { links: written.length, pairs: written.map((d) => `${d.from.agentId}>${d.to.agentId}`) },
  });
  return 'done';
}

// ── Readback ─────────────────────────────────────────────────────────────

const LIST_FIELDS = ['agent_id', 'limit', 'cursor', 'audit'] as const;

function boundedInteger(args: Record<string, unknown>, key: string, min: number, max: number, fallback: number): number {
  const value = args[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new DispatcherControlError('invalid_args', `${key} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

function readCursor(args: Record<string, unknown>): number {
  const value = args.cursor;
  if (value === undefined) return 0;
  if (typeof value !== 'string' || !/^\d{1,6}$/.test(value)) throw new DispatcherControlError('invalid_args', 'cursor must be next_cursor from the last page.');
  return Number(value);
}

export async function listOrchestratorControls(actorId: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!isDispatcherAgent(actorId)) throw new DispatcherControlError('not_dispatcher', 'Only the Dispatcher can do this.');
  assertOnly(args, LIST_FIELDS, '');
  const limit = boundedInteger(args, 'limit', 1, MAX_CONTROLS_PAGE, DEFAULT_CONTROLS_PAGE);
  const auditRows = boundedInteger(args, 'audit', 0, 50, 0);
  const cursor = readCursor(args);
  const agentId = args.agent_id === undefined ? undefined : requireId(args, 'agent_id');

  const census = await readAgentCensus();
  const everyone = agentId
    ? [requireOrchestrator(census, agentId)]
    : [...census.agents.values()].filter((e) => isConnectedOrchestrator(e.agent, e.policy));
  const page = everyone.slice(cursor, cursor + limit);
  const globalCap = orchestrationSettings.getGlobalHelperCap();
  const orchestrators = await Promise.all(page.map(async ({ agent, projectPath, projectName, policy }) => ({
    id: agent.id,
    name: agent.name,
    project: projectName,
    cross_project_helpers: { value: policy.crossProjectHelpers, source: policy.sources.crossProjectHelpers },
    max_helpers: { value: policy.maxHelpers, source: policy.sources.maxHelpers },
    live_helpers: (await listHelpersEverywhere(projectPath, agent.id)).length,
  })));

  const dispatcherOn = isDispatcherEnabled();
  const owned = listSoleOwnedPairs(DISPATCHER_CONNECTION_SOURCE_ID);
  // Only what is in the Dispatcher's store: a wire it didn't make is never listed as a link.
  const links = (await readDispatcherConnections())
    .filter((c) => !agentId || c.agentId === agentId || c.targetId === agentId)
    .map((c) => {
      const status = statusOf(c, census, dispatcherOn);
      const suspension = status === 'suspended' ? suspensionOf(c, census, dispatcherOn) : undefined;
      return {
        from: c.agentId,
        to: c.targetId,
        from_name: census.agents.get(c.agentId)?.agent.name ?? null,
        to_name: census.agents.get(c.targetId)?.agent.name ?? null,
        status,
        ...(suspension && { reason: suspension.reason, ...(suspension.agentId && { reason_agent: suspension.agentId }) }),
        // The user drew this pair too: their wire stays whatever happens to this link.
        ...(isBound(c) && !owned.some((p) => p.agentId === c.agentId && p.targetId === c.targetId) && { also_user_wire: true }),
        // What its sender may use now, and whether set_connection_tools can change it (#3215).
        ...directionReadback(c),
        created_at: c.createdAt,
      };
    });
  // Removed by the user, but not in the store yet. `saved` is false when a restart could lose it.
  const unconfirmed = (await listPendingRemovals())
    .filter((r) => !agentId || r.agentId === agentId || r.targetId === agentId)
    .slice(0, MAX_DISPATCHER_LINKS)
    .map((r) => ({ from: r.agentId, to: r.targetId, saved: r.saved }));
  const next = cursor + limit;
  return {
    global_cap: globalCap,
    max_helpers_ceiling: maxHelpersCeiling(globalCap),
    orchestrators,
    total: everyone.length,
    ...(next < everyone.length && { next_cursor: String(next) }),
    links,
    ...(unconfirmed.length > 0 && { unconfirmed_removals: unconfirmed }),
    // From the local telemetry record (#2920); ids are matched back against the agents it knows.
    ...(auditRows > 0 && { audit: await readDispatcherControls(auditRows, [actorId, ...census.agents.keys()]) }),
  };
}
