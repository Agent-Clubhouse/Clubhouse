/** Bounded diagnostics for desktop handoff refusals. Never reflect error text or paths. */
export const HANDOFF_TRANSFER_DIAGNOSTICS = [
  'unknown', 'peer_or_link', 'sender_authorization', 'record_missing', 'record_identity',
  'record_state', 'acceptance', 'agreement_binding', 'entry_binding', 'entry_expired',
  'request_expired', 'prepared_source', 'secret_policy', 'lease_notification', 'lease_authority', 'lease_peer', 'lease_config_generation', 'lease_saved_grants', 'lease_grant_revision', 'lease_dispatcher', 'lease_agent_authority',
  'lease_connection_notification', 'lease_binding_notification',
  'lease_binding_unrelated_agent', 'lease_binding_other_target', 'lease_binding_membership', 'lease_binding_permissions', 'lease_binding_metadata', 'lease_binding_unchanged',
  'snapshot_not_a_repository', 'snapshot_no_commits', 'snapshot_invalid_repository', 'snapshot_unsupported_repository',
  'snapshot_uncommitted_branch', 'snapshot_git_failed', 'snapshot_unsafe_entry', 'snapshot_source_changed',
  'snapshot_bounds_exceeded', 'snapshot_secret_blocked', 'snapshot_hash_mismatch', 'snapshot_filesystem_failed', 'snapshot_invalid_staging',
] as const;
export type HandoffTransferDiagnostic = typeof HANDOFF_TRANSFER_DIAGNOSTICS[number];
const tagged = new WeakMap<object, HandoffTransferDiagnostic>();
export function parseHandoffTransferDiagnostic(value: unknown): HandoffTransferDiagnostic {
  return typeof value === 'string' && (HANDOFF_TRANSFER_DIAGNOSTICS as readonly string[]).includes(value) ? value as HandoffTransferDiagnostic : 'unknown';
}
/** Keep the original error class/message; diagnostic labels never change the decision. */
export function tagHandoffTransferError<T>(error: T, code: HandoffTransferDiagnostic): T {
  if (code !== 'unknown' && error && typeof error === 'object' && !tagged.has(error)) tagged.set(error, code);
  return error;
}
export function handoffTransferDiagnostic(error: unknown): HandoffTransferDiagnostic {
  if (!error || typeof error !== 'object') return 'unknown';
  const label = tagged.get(error);
  if (label) return label;
  if (error instanceof Error && error.name === 'HandoffSnapshotError' && 'code' in error && typeof error.code === 'string') return parseHandoffTransferDiagnostic(`snapshot_${error.code}`);
  return 'unknown';
}
