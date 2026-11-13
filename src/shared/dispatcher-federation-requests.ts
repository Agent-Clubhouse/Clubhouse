import type { AnnexCallContext, AnnexDeliveryEpoch, AuthenticatedAnnexOrigin } from './annex-delivery';

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
  replies?: { revision: number; outcome: FederationOutcome; text: string; deliveryId?: string }[];
  duplicates: number;
  revocationNotified?: boolean;
  noticePending?: 'reply' | 'failure' | 'needs_user';
}
export type FederationRequestEnvelope =
  | { v: 1; kind: 'request'; id: string; originRequestId: string; text: string }
  | { v: 1; kind: 'reply'; id: string; originRequestId: string; revision: number; outcome: FederationOutcome; text: string }
  | { v: 1; kind: 'pause'; reason: string };
