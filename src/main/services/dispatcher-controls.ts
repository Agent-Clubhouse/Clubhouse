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
 * Every write call that reaches here leaves an audit row, refusals included. A
 * caller the registry's group gate refuses never gets here: that shows in the
 * tool-call telemetry instead.
 */

import { isDispatcherAgent } from './clubhouse-mcp/dispatcher-gate';
import { bindingManager } from './clubhouse-mcp/binding-manager';
import {
  appendAudit,
  auditNames,
  auditString,
  readAudit,
  type AuditRow,
  type AuditValue,
} from './dispatcher-audit';
import {
  DISPATCHER_CONNECTION_SOURCE_ID,
  DispatcherLinkRefused,
  addDispatcherConnections,
  bindingFor,
  isConnectedOrchestrator,
  isTombstoned,
  readAgentCensus,
  readDispatcherConnections,
  removeDispatcherConnections,
  statusOf,
  suspensionOf,
  type AgentCensus,
  type DispatcherConnection,
  type OrchestratorEntry,
} from './dispatcher-connections';
import { isDispatcherAgentId, isDispatcherEnabled } from './dispatcher/dispatcher-service';
import { listHelpersEverywhere } from './helper-index';
import { getHelperSummary, setOrchestrationPolicy } from './orchestration-policy';
import * as orchestrationSettings from './orchestration-settings';
import {
  claimSourceBinding,
  isBindingRemovedByUser,
  listSoleOwnedPairs,
  rebuildPersistedBindings,
  releaseSourceBinding,
} from './persisted-bindings';
import { isDisposedAgent } from '../../shared/agent-helpers';
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
  | 'policy_refused';

export class DispatcherControlError extends Error {
  constructor(readonly code: ControlRefusal, message: string) {
    super(message);
    this.name = 'DispatcherControlError';
  }
}

export const DEFAULT_CONTROLS_PAGE = 10;
export const MAX_CONTROLS_PAGE = 25;

const AUDIT_FAILED = 'The change was made, but it could not be written to the audit record.';

/** Run one tool call, leaving its audit row whatever happens. */
async function audited<T extends object>(
  row: Pick<AuditRow, 'tool' | 'actorId' | 'targets' | 'requested'>,
  run: () => Promise<{ result: T; before?: Record<string, AuditValue>; after?: Record<string, AuditValue>; code?: string }>,
): Promise<T & { audit_warning?: string }> {
  try {
    if (!isDispatcherAgent(row.actorId)) throw new DispatcherControlError('not_dispatcher', 'Only the Dispatcher can do this.');
    const { result, before, after, code } = await run();
    const written = await appendAudit({ ...row, outcome: 'ok', ...(before && { before }), ...(after && { after }), ...(code && { code }) });
    return written ? result : { ...result, audit_warning: AUDIT_FAILED };
  } catch (err) {
    const refusal = err instanceof DispatcherControlError ? err.code : undefined;
    await appendAudit({ ...row, outcome: refusal ? 'refused' : 'error', ...(refusal && { code: refusal }) });
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
const LINK_NOTE = 'Links the user made and your own wires can\'t be changed here.';

interface LinkRequest {
  from: string;
  to: string;
  pairs: Array<{ agentId: string; targetId: string }>;
}

function readLinkRequest(args: Record<string, unknown>): LinkRequest {
  assertOnly(args, LINK_FIELDS, LINK_NOTE);
  const from = requireId(args, 'from');
  const to = requireId(args, 'to');
  if (from === to) throw new DispatcherControlError('invalid_args', 'from and to must be different agents.');
  const twoWay = optionalFlag(args, 'two_way') ?? false;
  if (isDispatcherAgentId(from) || isDispatcherAgentId(to)) {
    throw new DispatcherControlError('dispatcher_wire', 'That is one of your own wires. Those follow the agent\'s Connect to Dispatcher setting, which is the user\'s.');
  }
  return { from, to, pairs: [{ agentId: from, targetId: to }, ...(twoWay ? [{ agentId: to, targetId: from }] : [])] };
}

function linkRow(tool: string, actorId: string, args: Record<string, unknown>): Pick<AuditRow, 'tool' | 'actorId' | 'targets' | 'requested'> {
  return {
    tool,
    actorId,
    targets: [args.from, args.to].filter((v): v is string => typeof v === 'string').map(auditString),
    requested: { fields: auditNames(Object.keys(args)), ...(typeof args.two_way === 'boolean' && { two_way: args.two_way }) },
  };
}

const isBound = (pair: { agentId: string; targetId: string }) =>
  bindingManager.getBindingsForAgent(pair.agentId).some((b) => b.targetId === pair.targetId);

const pairLabel = (a: OrchestratorEntry, b: OrchestratorEntry) => `${a.agent.name} → ${b.agent.name}`;

export async function connectOrchestrators(actorId: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return audited(linkRow('connect_orchestrators', actorId, args), async () => {
    const { from, to, pairs } = readLinkRequest(args);
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

    const outcomes = pairs.map((p) => claimSourceBinding(DISPATCHER_CONNECTION_SOURCE_ID, bindingFor(ends.get(p.agentId)!, ends.get(p.targetId)!)));
    // The user removed a pair between the check above and the claim: don't keep it.
    if (outcomes.includes('removed')) {
      // Only what this call added: a link it found already saved was there before it.
      await removeDispatcherConnections(added);
      for (const p of added) releaseSourceBinding(DISPATCHER_CONNECTION_SOURCE_ID, p.agentId, p.targetId);
      await rebuildPersistedBindings();
      throw new DispatcherControlError('removed_by_user', 'The user removed this connection. It stays removed until the user draws it again.');
    }
    await rebuildPersistedBindings();
    return {
      code: outcomes.join(','),
      result: { links: pairs.map((p, i) => ({ from: p.agentId, to: p.targetId, label: pairLabel(ends.get(p.agentId)!, ends.get(p.targetId)!), outcome: outcomes[i] })) },
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
    return {
      code: outcomes.join(','),
      result: { links: pairs.map((p, i) => ({ from: p.agentId, to: p.targetId, outcome: outcomes[i] })) },
    };
  });
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
        created_at: c.createdAt,
      };
    });
  const next = cursor + limit;
  return {
    global_cap: globalCap,
    max_helpers_ceiling: maxHelpersCeiling(globalCap),
    orchestrators,
    total: everyone.length,
    ...(next < everyone.length && { next_cursor: String(next) }),
    links,
    ...(auditRows > 0 && { audit: await readAudit(auditRows) }),
  };
}
