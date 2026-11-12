/** Annex delivery ends at the receiving tool/runtime, not model execution. */
export interface AnnexCallContext {
  rootId: string;
  depth: number;
  parentId?: string;
}

export interface AnnexDeliveryEpoch {
  sender: string;
  receiver: string;
}

export type AnnexDeliveryProtocolName = 'handoff' | 'federation';

export interface AnnexProtocolSourceCall {
  toolName: string;
  callKey: string;
}

/** Main-local receipt reference, never part of a remote agent-call envelope. */
export interface AnnexProtocolApprovalReference {
  requestId: string;
}

export interface AuthenticatedAnnexOrigin {
  /** The machine is authenticated; the pinned peer asserts the agent identity. */
  machineId: string;
  machineName: string;
  agentId: string;
  agentName: string;
}

export type AnnexDeliveryState = 'queued' | 'sending' | 'retry_later' | 'delivered' | 'refused' | 'expired' | 'indeterminate';

export interface AnnexDeliveryReceipt {
  callId: string;
  state: 'delivered' | 'refused' | 'retry_later' | 'indeterminate';
  reason?: string;
  receiptAt?: string;
}

export interface AnnexDeliveryStatus {
  callId: string;
  callerId: string;
  targetId: string;
  tool: string;
  state: AnnexDeliveryState;
  queuedAt: string;
  updatedAt: string;
  attempts: number;
  nextAttemptAt?: string;
  reason?: string;
}

export interface AnnexDeliveryFailure extends AnnexDeliveryStatus {
  state: 'refused' | 'expired' | 'indeterminate';
}
