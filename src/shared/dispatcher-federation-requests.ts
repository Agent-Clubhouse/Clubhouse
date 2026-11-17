import type { AnnexCallContext, AnnexDeliveryEpoch, AuthenticatedAnnexOrigin } from './annex-delivery';

export const FEDERATED_REQUEST_LIMITS = Object.freeze({ queued: 30, perMinute: 20, ttl: 7 * 24 * 60 * 60_000, records: 1000 });

/** A protocol refusal is returned before accepting new work. */
export class FederationRefusal extends Error {
  constructor(readonly code: 'rate_limited' | 'queue_full' | 'depth_unrepresentable', message: string, readonly retryAfterMs?: number) { super(message); }
  details() { return { code: this.code, message: this.message, ...(this.retryAfterMs !== undefined && { retryAfterMs: this.retryAfterMs }) }; }
}
export class FederationBackpressure extends FederationRefusal {
  constructor(code: 'rate_limited' | 'queue_full', message: string, retryAfterMs: number) { super(code, message, retryAfterMs); }
}
export function assertFederationDepth(depth: number): void {
  if (!Number.isSafeInteger(depth) || depth < 0) throw new FederationRefusal('depth_unrepresentable', 'The causal tracing depth cannot be represented safely.');
}
/** Tracing has no hop ceiling, but exact ancestry must remain representable. */
export function nextFederationDepth(depth: number): number {
  assertFederationDepth(depth);
  if (depth === Number.MAX_SAFE_INTEGER) throw new FederationRefusal('depth_unrepresentable', 'The next causal tracing depth cannot be represented safely.');
  return depth + 1;
}

/** Delivery is a transport fact. Only an explicit receiver report changes outcome. */
export type FederationDelivery = 'accepted' | 'delivered' | 'refused' | 'expired';
export type FederationOutcome = 'under_way' | 'waiting_user' | 'answered' | 'declined' | 'failed';
export type FederationTriage = 'now' | 'check_in' | 'needs_user' | 'decline';
export interface FederatedRequest {
  id: string;
  direction: 'incoming' | 'outgoing';
  callerId: string;
  machineId: string;
  targetId: string;
  origin: AuthenticatedAnnexOrigin;
  originRequestId: string;
  localRequestId: string;
  text: string;
  /** Main-only local delegation lineage; never placed in a federation envelope. */
  localWorkIds?: string[];
  cause: AnnexCallContext;
  epoch: AnnexDeliveryEpoch;
  createdAt: number;
  expiresAt: number;
  delivery: FederationDelivery;
  outcome: FederationOutcome;
  triage?: FederationTriage;
  promptState?: 'pending' | 'claimed' | 'accepted';
  reason?: string;
  deliveryId?: string;
  revision: number;
  receivedRevision: number;
  replies?: { rateAdmitted?: boolean; revision: number; outcome: FederationOutcome; text: string; deliveryId?: string; expiresAt?: number; delivery?: FederationDelivery; error?: string }[];
  replyPrompts?: { revision: number; outcome: FederationOutcome; text: string; cause: AnnexCallContext; state: 'pending' | 'claimed' | 'accepted' }[];
  duplicates: number;
  revocationNotified?: boolean;
  noticePending?: 'reply' | 'failure' | 'needs_user';
}
export type FederationRequestEnvelope =
  | { v: 1; kind: 'request'; id: string; originRequestId: string; text: string }
  | { v: 1; kind: 'reply'; id: string; originRequestId: string; revision: number; outcome: FederationOutcome; text: string }
  | { v: 1; kind: 'pause'; reason: string };
