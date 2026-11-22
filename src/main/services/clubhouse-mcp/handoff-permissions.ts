import { AsyncLocalStorage } from 'async_hooks';
import { resolveArgTargets } from './arg-targets';
import { checkToolGrant } from './grant-check';
import { callGrantIsApproved, grantApprovalContext } from './tool-registry';
import type { ToolGrantDeclaration } from './tool-grants';

export const HANDOFF_OFFER_GRANT: ToolGrantDeclaration = { actions: ['handoff.offer'], target: 'handoff_peer' };
export const HANDOFF_ACCEPT_GRANT: ToolGrantDeclaration = { actions: ['handoff.accept'], target: 'handoff_peer' };
type AgreementCall = { agentId: string; name: 'offer_handoff' | 'respond_to_handoff'; args: Record<string, unknown> };
const agreementCalls = new AsyncLocalStorage<AgreementCall>();

export function withHandoffAgreementCall<T>(call: AgreementCall, work: () => Promise<T>): Promise<T> {
  return agreementCalls.run(call, work);
}

/** Recheck the exact target, live policy and consumed approval at the durable write boundary. */
export async function handoffAgreementCallApproved(agentId: string, action: 'handoff.offer' | 'handoff.accept', expectedRecipient?: string): Promise<boolean> {
  const call = agreementCalls.getStore();
  if (!call || call.agentId !== agentId || (action === 'handoff.offer') !== (call.name === 'offer_handoff')) return false;
  const grant = action === 'handoff.offer' ? HANDOFF_OFFER_GRANT : HANDOFF_ACCEPT_GRANT;
  const targets = await resolveArgTargets(agentId, grant, call.args);
  if (expectedRecipient !== undefined) {
    const resolved = targets?.get(grant);
    if (resolved?.length !== 1 || resolved[0].agentId !== expectedRecipient) return false;
  }
  const check = checkToolGrant(agentId, grant, call.args, undefined, targets);
  return callGrantIsApproved(agentId, call.name, call.args, check,
    grantApprovalContext(agentId, call.name, call.args, grant, targets));
}
