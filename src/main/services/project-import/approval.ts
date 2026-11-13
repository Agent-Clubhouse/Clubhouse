import type { GrantRequest } from '../../../shared/grant-requests';
import { randomUUID } from 'crypto';
import { agentRegistry } from '../agent-registry';
import { callApprovalVersion, callKey } from '../grant-requests';
import { askFirst } from '../clubhouse-mcp/ask-first';
import { resolveArgTargets } from '../clubhouse-mcp/arg-targets';
import { checkToolGrant } from '../clubhouse-mcp/grant-check';
import { dispatcherGateVersion, isDispatcherAgent } from '../clubhouse-mcp/dispatcher-gate';
import { grantApprovalContext } from '../clubhouse-mcp/tool-registry';
import type { ToolGrant } from '../clubhouse-mcp/tool-grants';
import { ImportError } from './types';

const registrationIds = new WeakMap<object, string>();

/** A scoped one-time human answer, including when all policy grants say Allow. */
export async function approveImportCall(
  agentId: string,
  tool: string,
  args: Record<string, unknown>,
  grant: ToolGrant,
  review: Pick<GrantRequest, 'importReview' | 'agentReview'>,
) {
  const caller = agentRegistry.get(agentId);
  const callerSnapshot = JSON.stringify(caller);
  const gateVersion = dispatcherGateVersion();
  const approvalVersion = callApprovalVersion(agentId);
  const targets = await resolveArgTargets(agentId, grant, args);
  const grantContext = grantApprovalContext(agentId, tool, args, grant, targets);
  if (caller && !registrationIds.has(caller)) registrationIds.set(caller, randomUUID());
  const context = callKey(agentId, tool, {
    args, grantContext, callerSnapshot, registration: caller && registrationIds.get(caller), gateVersion, approvalVersion,
  });
  const current = () => {
    if (!caller || agentRegistry.get(agentId) !== caller || JSON.stringify(caller) !== callerSnapshot
      || !isDispatcherAgent(agentId) || dispatcherGateVersion() !== gateVersion
      || callApprovalVersion(agentId) !== approvalVersion) {
      throw new ImportError('authorization_changed', 'The original caller or authorization changed. Review again in Needs you; no further import or agent effect is authorized.');
    }
    const check = checkToolGrant(agentId, grant, args, undefined, targets);
    if (check.ok === false && check.reason !== 'ask_first') {
      throw new ImportError('not_permitted', 'The current Clubhouse permission refuses this operation. Ask the user to review its permissions; nothing further was attempted.');
    }
    if (grantApprovalContext(agentId, tool, args, grant, targets) !== grantContext) {
      throw new ImportError('authorization_changed', 'Permissions, access or the target changed since review. Obtain a new exact approval; nothing further was attempted.');
    }
  };
  current();
  const check = checkToolGrant(agentId, grant, args, undefined, targets);
  const asks = check.ok === false && check.reason === 'ask_first' ? check.asks : [
    { action: review.importReview ? 'project.add' as const : 'agent.create' as const, where: 'projects' },
  ];
  const decision = await askFirst(agentId, tool, args, asks, context, review);
  current();
  if (decision.kind === 'asked') return { kind: 'asked' as const, text: decision.text };
  return {
    kind: 'approved' as const,
    assertCurrent: async () => {
      const freshTargets = await resolveArgTargets(agentId, grant, args);
      current();
      if (grantApprovalContext(agentId, tool, args, grant, freshTargets) !== grantContext) {
        throw new ImportError('authorization_changed', 'The approved target is no longer current. Review the new scope before proceeding.');
      }
    },
  };
}
