/**
 * The user's answer to a Clubhouse permission request (#2970). Only the
 * user's own surfaces call this: Needs you, and `grant.answer` (#3205) from
 * a device that controls this computer, which comes through here too.
 *
 * - A call request: Allow lets that one call through when the agent makes it
 *   again; the agent's permissions don't change.
 * - A permission request: Allow adds the permission to the agent's saved
 *   permissions, through the same path as its permissions page.
 *
 * Either way the agent is told, if it is running.
 */

import { GRANT_ACTION_LABELS } from '../../shared/agent-grant-changes';
import type { GrantRequest, GrantRequestAnswer } from '../../shared/grant-requests';
import { setAgentGrant } from './agent-grants-service';
import { deliverHelperUpdate } from './clubhouse-mcp/tools/helper-delivery';
import { finishGrantAnswer, grantRequestKey, peekGrantRequest, restoreGrantRequest, takeGrantRequest } from './grant-requests';
import { appLog } from './log-service';
import { recordGrantRequest } from './grant-telemetry';
import { currentSettingsOrigin } from './settings-audit';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function tell(agentId: string, text: string): void {
  deliverHelperUpdate(agentId, `[Clubhouse] ${text}`, { fromClubhouse: true, text }).then((delivery) => {
    if (delivery !== 'delivered') appLog('core:mcp', 'info', 'Permission answer not delivered: the agent is not running', { meta: { agentId, delivery } });
  }).catch((err: unknown) => {
    // telemetry-exempt: logged; the answer stands whether or not the agent hears it
    appLog('core:mcp', 'warn', 'Permission answer not delivered', { meta: { agentId, error: errorText(err) } });
  });
}

function what(request: GrantRequest): string {
  if (request.kind === 'call') return `your ${request.toolName ?? 'tool'} call`;
  const action = request.actions[0];
  return `${GRANT_ACTION_LABELS[action] ?? action} (${action}) on ${request.where}`;
}

export async function answerGrantRequest(requestId: string, allow: boolean, updateMode?: import('../../shared/app-update').AppUpdateMode, assertAuthorized?: () => void): Promise<GrantRequestAnswer> {
  if (peekGrantRequest(requestId)?.update) {
    const { answerAppUpdateRequest } = await import('./app-update-request');
    assertAuthorized?.();
    return answerAppUpdateRequest(requestId, allow, updateMode);
  }
  if (updateMode !== undefined) return { ok: false, error: 'This request is not an update approval.' };
  // Used up before anything is saved, so a second answer, or the expiry, can't land meanwhile.
  const key = grantRequestKey(requestId);
  const request = takeGrantRequest(requestId, allow);
  if (!request || key === null) return { ok: false, error: 'This request has expired or was already answered.' };
  if (allow && request.kind === 'grant' && request.target) {
    try {
      await setAgentGrant(request.projectPath, request.agentId, { action: request.actions[0], target: request.target, mode: 'allow' });
    } catch (err) {
      // Put back, so the user can decline it or change the permissions page instead.
      restoreGrantRequest(request, key);
      return { ok: false, error: errorText(err) };
    }
  }
  finishGrantAnswer(requestId);
  recordGrantRequest({ agentId: request.agentId, kind: request.kind, outcome: allow ? 'allowed' : 'declined', actions: request.actions });
  appLog('core:mcp', 'info', allow ? 'Permission request allowed' : 'Permission request declined', {
    meta: { agentId: request.agentId, requestId, kind: request.kind, surface: currentSettingsOrigin().surface },
  });
  if (!allow) tell(request.agentId, `The user declined ${what(request)}. Don't ask again for the same thing; carry on without it or ask them in your reply.`);
  else if (request.kind === 'call') tell(request.agentId, `The user allowed ${what(request)}. Make the same call again, with the same arguments, to run it once.`);
  else tell(request.agentId, `The user allowed ${what(request)}. You have it now.`);
  return { ok: true };
}
