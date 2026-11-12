import { createDurableCallApprovals, DurableApprovalError } from './durable-call-approvals';
import { dropCallApprovalsFor, readOriginalAllowedCall } from './grant-requests';
import { agentGrantChangePending } from './agent-grants-store';

const answering = new Map<string, (() => void) | undefined>();

export const durableGrantApprovals = createDurableCallApprovals((requestId) => {
  if (!answering.has(requestId)) return undefined;
  // A queued write must recheck the answering device, not borrow settings-surface ALS.
  answering.get(requestId)?.();
  const original = readOriginalAllowedCall(requestId);
  if (!original || original.scope.durable !== true) return undefined;
  if (agentGrantChangePending(original.callerId)) throw new DurableApprovalError('approval_changed', 'Permissions are changing. Wait for them to finish before asking again.');
  return { ...original, scope: { ...original.scope, durable: true } };
});

/** Called only by the actual user-answer path, never a tool handler or approval consumer. */
export async function persistDurableGrantAnswer(requestId: string, assertAuthorized?: () => void): Promise<void> {
  const original = readOriginalAllowedCall(requestId);
  if (!original || original.scope.durable !== true) throw new DurableApprovalError('approval_not_original', 'There is no original allowed durable call answer.');
  answering.set(requestId, assertAuthorized);
  try {
    await durableGrantApprovals.approveAnsweredRequest(requestId);
  } finally {
    answering.delete(requestId);
  }
}

export async function invalidateCallApprovalsFor(agentId: string): Promise<void> {
  dropCallApprovalsFor(agentId);
  await durableGrantApprovals.revokeCaller(agentId);
}
