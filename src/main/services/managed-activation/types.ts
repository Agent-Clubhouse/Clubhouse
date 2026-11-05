import type { BaseAdoption } from '../../../shared/asset-catalog-types';

export type ActivationErrorCode =
  | 'activation_incompatible_config'
  | 'activation_skill_unsupported' | 'activation_capability_unproven' | 'activation_capability_stale'
  | 'activation_runtime_unreconciled'
  | 'activation_busy' | 'activation_stale' | 'activation_corrupt' | 'activation_not_permitted'
  | 'activation_unsupported' | 'activation_resume_unproven' | 'activation_scope_changed'
  | 'activation_workspace_shared' | 'activation_foreign_output' | 'activation_output_changed'
  | 'activation_io_failed' | 'activation_start_failed';

/** Codes only: instruction text, file contents and provider diagnostics stay out of errors. */
export class ManagedActivationError extends Error {
  constructor(readonly code: ActivationErrorCode) { super(code); }
}

export interface OutputFile {
  path: string;
  hash: string;
  executable: boolean;
}

export interface ActivationScope {
  projectPath: string;
  workspacePath: string;
  /** Canonical directory identity, checked again at every start. */
  workspaceKey: string;
  provider: 'claude-code';
}

export interface PreparedGeneration {
  id: string;
  pinId: string;
  frozenHash: string;
  adoption: BaseAdoption;
  compositionRevision: number;
  planFingerprint: string;
  instructionHash: string;
  preparedAt: string;
  files: OutputFile[];
  skillRoots: string[];
  materializedAt?: string;
  /** Only process creation/exit observations. No tool visibility, authorization or prompt claims. */
  skillNames: string[];
  capability: import('./capability').DeliveryCapability;
  runs: Array<{ attemptId: string; intendedAt: string; runtimeIdentity?: string; startedAt?: string; endedAt?: string;
    outcome?: 'pty_process_created' | 'process_started_receipt_failed' | 'process_not_created'; cleanupRequested?: boolean; cleanupConfirmed?: boolean; cleanupFailure?: string }>;
}

export interface ActivationReceipt {
  version: 1;
  agentId: string;
  revision: number;
  scope: ActivationScope;
  /** Explicitly requested snapshot for the next fresh start. Never changes the running generation. */
  desired: string | null;
  generations: Record<string, PreparedGeneration>;
  materialized: string | null;
  /** Durable intent before the first workspace write; interruption is rolled forward before launch. */
  pending?: { from: string | null; to: string | null };
}

/** A process exists even when persistence failed. Legacy spawn catches must preserve its registry. */
export class ProcessStartedReceiptError extends Error {
  readonly code = 'process_started_receipt_failed';
  cleanupRequested = false;
  cleanupConfirmed = false;
  cleanupFailure?: 'request_failed' | 'exit_unconfirmed' | 'identity_changed';
  constructor(readonly attemptId: string, readonly runtimeIdentity: string) { super('process_started_receipt_failed'); }
}
