/**
 * A call a permission set to Ask first covers (#2970, part of #2921). The
 * call doesn't wait: it records a request in Needs you and returns at once,
 * saying so. When the user allows it, the agent is told and calls again with
 * the same arguments, which goes through once. Declining tells the agent too.
 */

import { GRANT_ACTION_LABELS } from '../../../shared/agent-grant-changes';
import { GRANT_REQUEST_DETAILS_MAX, GRANT_REQUEST_REASON_MAX } from '../../../shared/grant-requests';
import { getDurableConfig } from '../agent-config';
import { agentRegistry } from '../agent-registry';
import { callKey, consumeCallApproval, recordGrantRequest } from '../grant-requests';
import { appLog } from '../log-service';
import type { AskedAction } from './grant-check';

/** Every argument, for the user to see exactly what Allow would run. */
function argsText(args: Record<string, unknown>): string | undefined {
  return Object.keys(args).length === 0 ? undefined : JSON.stringify(args, null, 2);
}

export async function agentNameOf(agentId: string, projectPath: string | undefined): Promise<string> {
  if (!projectPath) return agentId;
  try {
    return (await getDurableConfig(projectPath, agentId))?.name ?? agentId;
  } catch {
    // telemetry-exempt: the id names it well enough when the config can't be read
    return agentId;
  }
}

export type AskFirstOutcome =
  /** The user allowed this exact call: run it. */
  | { kind: 'approved' }
  /** Not yet: tell the agent this. */
  /** Not yet: tell the agent this. `created`: a new request went to Needs you (only then is it recorded, #2973). */
  | { kind: 'asked'; text: string; created?: boolean };

export async function askFirst(agentId: string, toolName: string, args: Record<string, unknown>, asks: AskedAction[]): Promise<AskFirstOutcome> {
  const key = callKey(agentId, toolName, args);
  if (consumeCallApproval(key)) {
    appLog('core:mcp', 'info', 'Ask-first call approved by the user', { meta: { agentId, toolName } });
    return { kind: 'approved' };
  }
  const projectPath = agentRegistry.get(agentId)?.projectPath;
  if (!projectPath) {
    return { kind: 'asked', text: 'This call needs the user\'s approval, and Clubhouse couldn\'t place your request. Ask the user directly.' };
  }
  const details = argsText(args);
  if (details && details.length > GRANT_REQUEST_DETAILS_MAX) {
    return { kind: 'asked', text: 'This call needs the user\'s approval, and its arguments are too long for them to review. Make smaller calls, or ask the user directly.' };
  }
  const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim().slice(0, GRANT_REQUEST_REASON_MAX) : undefined;
  const recorded = recordGrantRequest(key, {
    kind: 'call',
    agentId,
    agentName: await agentNameOf(agentId, projectPath),
    projectPath,
    actions: [...new Set(asks.map((a) => a.action))],
    where: [...new Set(asks.map((a) => a.where))].join(', '),
    toolName,
    ...(details && { details }),
    ...(reason && { reason }),
  });
  if (recorded.ok === false) {
    return { kind: 'asked', text: `You already have ${recorded.waiting} requests waiting for the user. Wait for an answer before asking again.` };
  }
  appLog('core:mcp', 'info', 'Ask-first call sent to the user', {
    meta: { agentId, toolName, requestId: recorded.request.requestId, reused: recorded.reused },
  });
  const needs = asks.map((a) => `${GRANT_ACTION_LABELS[a.action] ?? a.action} (${a.action}) on ${a.where}`).join('; ');
  return {
    kind: 'asked',
    created: !recorded.reused,
    text: `Not done yet: this needs the user's approval (${needs}). It's waiting in their Needs you list${recorded.reused ? ' (you asked already)' : ''}. `
      + 'Clubhouse will message you when they answer. If they allow it, make the same call again with the same arguments; it goes through once.',
  };
}
