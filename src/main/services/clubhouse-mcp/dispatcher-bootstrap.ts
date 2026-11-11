import { randomUUID } from 'crypto';
import type { DurableAgentConfig, Project } from '../../../shared/types';
import type { ConnectionDirection } from '../../../shared/connection-grants';
import { NEW_CONNECTION_SWITCHES, localDirectionTools } from '../../../shared/connection-grants';
import { isDisposedAgent } from '../../../shared/agent-helpers';
import { auditString, recordDispatcherControl } from '../../telemetry/dispatcher-telemetry';
import * as agentConfig from '../agent-config';
import { getOrchestrationPolicy, setOrchestrationPolicy } from '../orchestration-policy';
import { getConnectionDirection, rollBackConnectionDirections, setConnectionDirections } from '../connection-grants-store';
import { isTombstoned } from '../dispatcher-connections';
import { isBindingRemovedByUser, rebuildPersistedBindings, releaseSourceBinding } from '../persisted-bindings';
import { DISPATCHER_WIRE_SOURCE_ID } from '../dispatcher-wire-source';
import { callKey } from '../grant-requests';
import { askFirst } from './ask-first';
import { resolveArgTargets } from './arg-targets';
import { checkToolGrant } from './grant-check';
import { isDispatcherAgent } from './dispatcher-gate';
import type { ToolGrant } from './tool-grants';
import type { McpToolResult } from './types';
import { bindingManager } from './binding-manager';

const TOOL = 'create_managed_agent';
const json = (value: object, isError = false): McpToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], ...(isError && { isError }),
});

interface CreatedCall {
  result: McpToolResult;
  payload: Record<string, unknown>;
  config: DurableAgentConfig;
  receiptId: string;
}

// Like call approvals, retry receipts live for this app session. Completed calls
// never run creation again, even if the user later removes their connection.
const completed = new Map<string, CreatedCall>();
const inFlight = new Map<string, Promise<McpToolResult>>();

export function _resetDispatcherBootstrapForTesting(): void {
  completed.clear();
  inFlight.clear();
}

class BootstrapRefused extends Error {}

/** Create-and-connect is one authorized call, with no existing-agent target. */
export async function createDispatcherManagedAgent(
  actorId: string,
  args: Record<string, unknown>,
  project: Pick<Project, 'path' | 'name'>,
  grant: ToolGrant,
  create: () => Promise<DurableAgentConfig>,
  extra: Record<string, unknown> = {},
): Promise<McpToolResult> {
  const connect = args.connectToDispatcher === true;
  const approvalArgs = connect ? {
    ...args, project: project.path, dispatcherId: actorId,
    connectionSwitches: NEW_CONNECTION_SWITCHES,
  } : args;
  const key = callKey(actorId, TOOL, approvalArgs);
  const cached = connect ? completed.get(key) : undefined;
  if (cached) {
    const config = await agentConfig.getDurableConfig(project.path, cached.config.id);
    const policy = config && !isDisposedAgent(config) ? await getOrchestrationPolicy(project.path, config.id) : null;
    if (policy?.connectToDispatcher && !isBindingRemovedByUser(actorId, cached.config.id)
      && !isBindingRemovedByUser(cached.config.id, actorId)) return cached.result;
    recordDispatcherControl({ tool: TOOL, actorId, targets: [cached.config.id], requested: { receiptId: cached.receiptId }, outcome: 'refused', code: 'connection_removed' });
    return json({
      ...cached.payload,
      connectedToDispatcher: false,
      note: 'This call already created the agent. Its connection was removed or the agent is no longer available. Nothing was recreated. Ask the user to reconnect it.',
    }, true);
  }
  const running = connect ? inFlight.get(key) : undefined;
  if (running) return running;

  const run = async (): Promise<McpToolResult> => {
    const receiptId = randomUUID();
    const requested = { receiptId, agent: auditString(args.name), project: auditString(project.name), connectToDispatcher: connect };
    const audit = (outcome: 'ok' | 'refused' | 'error', targetId?: string, code?: string) => recordDispatcherControl({
      tool: TOOL, actorId, targets: targetId ? [targetId] : [], requested, outcome, ...(code && { code }),
      ...(outcome === 'ok' && { after: { connectedToDispatcher: connect } }),
    });
    let config: DurableAgentConfig | undefined;
    let written: ConnectionDirection[] = [];
    try {
      if (!isDispatcherAgent(actorId)) throw new BootstrapRefused('Only the Dispatcher can create and connect an agent.');
      const check = checkToolGrant(actorId, grant, args, undefined, await resolveArgTargets(actorId, grant, args));
      if (check.ok === false) {
        if (check.reason !== 'ask_first') throw new BootstrapRefused(check.message);
        const approval = await askFirst(actorId, TOOL, approvalArgs, check.asks);
        if (approval.kind === 'asked') {
          audit('refused', undefined, 'awaiting_approval');
          return json({ status: 'needs_approval', connectedToDispatcher: false, receipt: { id: receiptId, outcome: 'needs_approval' }, note: approval.text }, true);
        }
      }
      config = await create();
      if (connect) {
        const created = config;
        const targetId = created.id;
        const pairs = [{ agentId: actorId, targetId }, { agentId: targetId, targetId: actorId }];
        const assertTarget = (agent: DurableAgentConfig) => {
          if (agent.id !== targetId || agent.id === actorId || agent.parentAgentId || isDisposedAgent(agent)) {
            throw new BootstrapRefused('Only the ordinary agent created by this call can be connected.');
          }
          if (pairs.some((p) => isBindingRemovedByUser(p.agentId, p.targetId))) {
            throw new BootstrapRefused('The user removed this connection. It stays removed.');
          }
        };
        assertTarget(config);
        for (const pair of pairs) if (await isTombstoned(pair)) throw new BootstrapRefused('The user removed this connection. It stays removed.');
        // Save narrow switches before policy can expose the automatic wires.
        // The guard runs under the store lock, and keeps any user-owned entry.
        written = await setConnectionDirections(pairs.map((p) => ({
          from: { agentId: p.agentId }, to: { agentId: p.targetId }, ...NEW_CONNECTION_SWITCHES,
        })), (current) => { assertTarget(created); return current ? false : undefined; });
        const saved = await setOrchestrationPolicy(project.path, targetId, { connectToDispatcher: true }, {
          surface: 'dispatcher', actorId, precondition: assertTarget, connectionBootstrap: true,
        });
        if (!saved.ok) throw new BootstrapRefused(saved.message);
        await rebuildPersistedBindings();
        const latest = await agentConfig.getDurableConfig(project.path, targetId);
        if (!latest) throw new BootstrapRefused('The new agent was removed before it could be connected.');
        assertTarget(latest);
        if (!(await getOrchestrationPolicy(project.path, targetId))?.connectToDispatcher) {
          throw new BootstrapRefused('The user turned off this connection. It stays off.');
        }
        if (pairs.some((p) => !bindingManager.getBindingsForAgent(p.agentId).some((b) => b.targetKind === 'agent' && b.targetId === p.targetId))) {
          throw new BootstrapRefused('The Dispatcher connection could not be made. Nothing was left connected.');
        }
      }
      const recorded = audit('ok', config.id);
      const payload = {
        id: config.id, name: config.name, project: project.name, managed: !!config.managed, status: 'sleeping',
        ...extra, connectedToDispatcher: connect,
        ...(connect ? {
          receipt: {
            id: receiptId, outcome: 'connected', dispatcherId: actorId, agentId: config.id,
            directions: [[actorId, config.id], [config.id, actorId]].map(([from, to]) => ({
              from, to, tools: localDirectionTools(getConnectionDirection({ agentId: from }, { agentId: to })),
            })),
          },
          note: 'Connected to the Dispatcher. Use its generated wake_agent tool to start it with a task. Retrying this same call returns this receipt without creating another agent.',
        } : { nextStep: 'Not connected to the Dispatcher. Ask the user to enable Connect to Dispatcher before trying to wake or message it.' }),
        ...(!recorded && { audit_warning: 'Local telemetry recording is off, so this is not in the audit record.' }),
      };
      const result = json(payload);
      if (connect) completed.set(key, { result, config, payload, receiptId });
      return result;
    } catch (err) {
      audit(err instanceof BootstrapRefused ? 'refused' : 'error', config?.id, 'bootstrap_failed');
      if (!connect) throw err;
      const cleanup: unknown[] = [];
      if (config && config.id !== actorId && !config.parentAgentId && !isDisposedAgent(config)) {
        try {
          const reset = await setOrchestrationPolicy(project.path, config.id, { connectToDispatcher: false }, { surface: 'dispatcher', actorId, connectionBootstrap: true });
          if (!reset.ok) cleanup.push(new Error(reset.message));
        } catch (error) {
          // telemetry-exempt: returned in rollbackErrors; the remaining cleanup must still run
          cleanup.push(error);
        }
        releaseSourceBinding(DISPATCHER_WIRE_SOURCE_ID, actorId, config.id);
        releaseSourceBinding(DISPATCHER_WIRE_SOURCE_ID, config.id, actorId);
        try { await agentConfig.deleteDurable(project.path, config.id); } catch (error) {
          // telemetry-exempt: returned in rollbackErrors; the remaining cleanup must still run
          cleanup.push(error);
        }
      }
      try { await rollBackConnectionDirections(written); } catch (error) {
        // telemetry-exempt: returned in rollbackErrors; the remaining cleanup must still run
        cleanup.push(error);
      }
      if (config) try { await rebuildPersistedBindings(); } catch (error) {
        // telemetry-exempt: returned in rollbackErrors alongside the original failure
        cleanup.push(error);
      }
      const message = err instanceof Error ? err.message : String(err);
      const outcome = err instanceof BootstrapRefused ? 'refused' : 'failed';
      return json({
        status: outcome, connectedToDispatcher: false, receipt: { id: receiptId, outcome, ...(config && { agentId: config.id }) },
        error: message,
        ...(cleanup.length && { rollbackErrors: cleanup.map((e) => e instanceof Error ? e.message : String(e)) }),
      }, true);
    }
  };
  const operation = run();
  if (connect) inFlight.set(key, operation);
  try { return await operation; } finally { if (connect) inFlight.delete(key); }
}
