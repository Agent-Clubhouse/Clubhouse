/** Local-user DTOs only. No binary identities, private paths, manifests or main service classes. */
export interface ActivationTarget { projectId: string; agentId: string }
export interface ActivationPolicyChoice {
  content: 'takeable' | 'hold-preview';
  structure: 'accepted' | 'latest-if-clean';
}
export interface ActivationPreviewRequest {
  target: ActivationTarget;
  compositionRevision: number;
  receiptRevision: number;
  policy: ActivationPolicyChoice;
}
export interface ActivationAdoptRequest extends ActivationPreviewRequest { deliveryToken: string }
export interface ActivationUnassignRequest { target: ActivationTarget; receiptRevision: number }
export interface ActivationDeliveryPreview {
  target: ActivationTarget;
  compositionRevision: number;
  receiptRevision: number;
  policy: ActivationPolicyChoice;
  deliveryToken: string;
  instructions: string;
  instructionLabel: 'Appended managed instructions';
  ambientContext: string;
  skillNames: string[];
  cliVersion: string;
}
export interface ActivationObservation {
  attemptId: string;
  intendedAt: string;
  startedAt?: string;
  endedAt?: string;
  outcome?: 'pty_process_created' | 'process_started_receipt_failed' | 'process_not_created';
  cleanupRequested?: boolean;
  cleanupConfirmed?: boolean;
}
export interface ActivationGenerationView {
  id: string;
  compositionRevision: number;
  preparedAt: string;
  materializedAt?: string;
  skillNames: string[];
  observations: ActivationObservation[];
}
export interface ActivationReceiptView {
  target: ActivationTarget;
  compositionRevision: number;
  receiptRevision: number;
  desiredGenerationId: string | null;
  materializedGenerationId: string | null;
  generations: ActivationGenerationView[];
}
export type ActivationUiErrorCode = 'stale' | 'target_unavailable' | 'not_permitted' | 'unsupported' | 'incompatible'
  | 'capability_unproven' | 'capability_stale' | 'busy' | 'catalog_blocked' | 'skill_unsupported' | 'unreconciled' | 'failed';
export type ActivationUiResult<T> = { ok: true; view: T } | { ok: false; code: ActivationUiErrorCode };
