/**
 * Approvals from other computers, answered in the lead's chat (#3354).
 *
 * The lead's chat lists the Ask-first requests waiting on the other computers
 * in the network, from their snapshots, each with its computer first. A
 * person's click here sends `grant.answer` to that computer over the pinned
 * connection, as Needs you there would, and that computer checks it again: it
 * applies only while the request is still pending and the answer still
 * offered. The first answer wins; the other surface drops it with its next
 * snapshot.
 *
 * Only the IPC behind that click calls this. No tool, controller
 * link or message can answer one: news and messages never carry approvals.
 */

import { MOBILE_GRANT_ANSWERS } from '../../shared/mobile-control';
import * as annexClient from './annex-client';
import { leadRole } from './dispatcher-federation-lead';
import { listPeers, peerNeedsPairing } from './annex-peers';
import { appLog } from './log-service';

/** Refusals in words, from the computer the request is on. */
const REFUSALS: Record<string, string> = {
  grant_request_not_found: 'It was already answered, or it ended, on that computer.',
  grant_answer_not_offered: 'That answer isn’t offered for this request. Answer it on that computer.',
  grant_answer_failed: 'That computer couldn’t apply the answer. Answer it there.',
  authorization_revoked: 'This computer is no longer paired with that one.',
  epoch_mismatch: 'That computer restarted. Try again.',
  command_capacity: 'That computer is busy. Try again in a moment.',
};

export async function answerFollowerApproval(machine: string, requestId: string, answer: string): Promise<void> {
  if (!(MOBILE_GRANT_ANSWERS as readonly string[]).includes(answer)) throw new Error('That isn’t an answer a request takes.');
  if (leadRole() !== 'lead') throw new Error('Only the lead’s chat answers requests from other computers.');
  const fp = machine.toLowerCase();
  if (!listPeers().some((p) => p.fingerprint.toLowerCase() === fp && p.role === 'member' && p.kind !== 'phone' && !peerNeedsPairing(p))) {
    throw new Error('That computer isn’t in this Annex Network.');
  }
  const key = annexClient.satelliteKeyFor(fp);
  if (!key || !annexClient.isMachineConnected(fp)) throw new Error('That computer is offline. Answer it when it’s back, or on that computer.');
  const receipt = await annexClient.answerRemoteGrantRequest(key, requestId, answer) as { status?: string; error?: { code?: string; message?: string } } | null;
  if (receipt?.status === 'completed') {
    appLog('core:dispatcher', 'info', 'Answered another computer’s request from the lead', { meta: { answer } });
    return;
  }
  const code = receipt?.error?.code ?? '';
  throw new Error(REFUSALS[code] ?? (receipt?.error?.message && receipt.error.message !== code ? receipt.error.message : 'That computer refused the answer.'));
}
