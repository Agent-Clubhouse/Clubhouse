/**
 * request_grant (#2970, part of #2921): an agent asks the user for a
 * Clubhouse permission for itself, with its reason. It lands in Needs you;
 * Allow adds the permission to the agent's permissions page, where the user
 * can see and remove it. The agent never gets it by asking alone, and can
 * only ask for itself (`grant.request` on self, which every agent holds).
 */

import { GRANT_ACTIONS, type GrantAction, type GrantTarget } from '../../../../shared/agent-grants';
import { GRANT_ACTION_LABELS, grantKey, grantTargetLabel, isFixedGrant, normalizeGrantChanges } from '../../../../shared/agent-grant-changes';
import { GRANT_REQUEST_REASON_MAX } from '../../../../shared/grant-requests';
import { getDurableConfig } from '../../agent-config';
import { agentRegistry } from '../../agent-registry';
import { recordGrantRequest } from '../../grant-requests';
import { appLog } from '../../log-service';
import { agentNameOf } from '../ask-first';
import { callerGrants } from '../grant-check';
import { registerGlobalTool } from '../tool-registry';
import type { McpToolResult } from '../types';

const text = (t: string, isError = false): McpToolResult => ({ content: [{ type: 'text', text: t }], ...(isError && { isError: true }) });

/** The targets an agent can name, as the tool takes them. */
export const REQUEST_GRANT_TARGETS = ['self', 'parent', 'my_helpers', 'connected', 'own_project', 'any_project', 'app', 'any', 'action'] as const;
type RequestTarget = (typeof REQUEST_GRANT_TARGETS)[number];

function targetOf(name: RequestTarget, actionId: unknown): GrantTarget | string {
  switch (name) {
    case 'own_project': return { kind: 'project', project: 'own' };
    case 'any_project': return { kind: 'project', project: 'any' };
    case 'action':
      return typeof actionId === 'string' && actionId.trim() ? { kind: 'action', id: actionId.trim() } : 'target "action" needs action_id: the Action\'s id.';
    default: return { kind: name };
  }
}

export function registerGrantRequestTools(): void {
  registerGlobalTool(
    'request_grant',
    {
      description:
        'Ask the user for a Clubhouse permission for yourself, when a call was refused for lack of one. '
        + 'It goes to their Needs you list with your reason; nothing changes until they allow it, and Clubhouse messages you when they answer. '
        + 'Ask only for what the task needs. You can\'t ask for permissions for other agents.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: [...GRANT_ACTIONS], description: 'The permission, as a refusal names it (for example settings.app.write).' },
          target: { type: 'string', enum: [...REQUEST_GRANT_TARGETS], description: 'Where: self, parent (your orchestrator), my_helpers, connected (agents you are connected to), own_project, any_project, app, any, or action (with action_id).' },
          action_id: { type: 'string', description: 'With target "action": the Action\'s id.' },
          reason: { type: 'string', description: 'Why you need it, in a sentence or two. The user sees this.' },
        },
        required: ['action', 'target', 'reason'],
      },
    },
    async (agentId, args) => {
      const reason = typeof args.reason === 'string' ? args.reason.trim().slice(0, GRANT_REQUEST_REASON_MAX) : '';
      if (!reason) return text('reason is required: say why you need it.', true);
      if (!REQUEST_GRANT_TARGETS.includes(args.target as RequestTarget)) return text(`target must be one of ${REQUEST_GRANT_TARGETS.join(', ')}.`, true);
      const target = targetOf(args.target as RequestTarget, args.action_id);
      if (typeof target === 'string') return text(target, true);
      const checked = normalizeGrantChanges({ changes: [{ action: args.action, target, mode: 'allow' }] })?.changes[0];
      if (!checked) return text(`Not a Clubhouse permission. action must be one of the listed actions.`, true);
      if (isFixedGrant(checked)) return text('That permission is fixed and can\'t be changed.', true);
      if (checked.action === 'agent.create' || checked.action === 'agent.dispose') {
        // These follow the orchestrator's approval setting, which only the user changes, on its Helpers page.
        return text('Starting and removing helpers follow your approval setting, which only the user changes. Ask them in your reply.', true);
      }

      const projectPath = agentRegistry.get(agentId)?.projectPath;
      const config = projectPath ? await getDurableConfig(projectPath, agentId).catch((): null => null) : null;
      if (!projectPath || !config) return text('Only agents with saved settings have Clubhouse permissions to change. Ask the user directly.', true);
      if (callerGrants(agentId).some((g) => g.mode === 'allow' && grantKey(g) === grantKey(checked))) {
        return text('You already have that permission. If a call was still refused, the refusal names what is missing.');
      }

      const action = checked.action as GrantAction;
      const recorded = recordGrantRequest(`grant\0${agentId}\0${grantKey(checked)}`, {
        kind: 'grant',
        agentId,
        agentName: await agentNameOf(agentId, projectPath),
        projectPath,
        actions: [action],
        target: checked.target,
        where: grantTargetLabel(checked.target),
        reason,
      });
      if (recorded.ok === false) {
        return text(`You already have ${recorded.waiting} requests waiting for the user. Wait for an answer before asking again.`, true);
      }
      appLog('core:mcp', 'info', 'Permission request sent to the user', {
        meta: { agentId, action, requestId: recorded.request.requestId, reused: recorded.reused },
      });
      return text(
        `Asked the user for ${GRANT_ACTION_LABELS[action]} (${action}) on ${grantTargetLabel(checked.target)}`
        + `${recorded.reused ? ' (you asked already)' : ''}. Nothing has changed yet. Clubhouse will message you when they answer.`,
      );
    },
    { grant: { actions: ['grant.request'], target: 'self' } },
  );
}
