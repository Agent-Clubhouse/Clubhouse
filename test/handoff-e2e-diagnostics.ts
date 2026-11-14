import { HANDOFF_STATES } from '../src/shared/handoffs';

const steps = ['authorization', 'transfer', 'verification', 'apply', 'wake', 'recovery'];
const failureCodes = ['refused', 'expired', 'authorization_changed', 'transfer_failed', 'verification_failed', 'apply_failed', 'wake_failed', 'indeterminate_apply'];
const snapshotCodes = ['not_a_repository', 'no_commits', 'invalid_repository', 'unsupported_repository', 'uncommitted_branch', 'git_failed', 'unsafe_entry', 'source_changed', 'bounds_exceeded', 'secret_blocked', 'hash_mismatch', 'filesystem_failed', 'invalid_staging'];
const fixtureFiles = ['work.txt', 'fixtures/selected.bin', 'fixtures/excluded.bin', 'blocked.txt', 'bundle.bin'];
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const choice = (value: unknown, allowed: readonly string[]) => typeof value === 'string' && allowed.includes(value) ? value : 'unknown';

function reason(value: unknown) {
  if (typeof value !== 'string' || !value) return { reason: 'not_recorded' };
  const snapshot = /^Handoff snapshot failed: ([a-z_]+)(?: \(([^)]*)\))?\.$/.exec(value);
  if (snapshot && snapshotCodes.includes(snapshot[1])) return {
    reason: 'snapshot', snapshotCode: snapshot[1],
    ...(snapshot[2] && { file: fixtureFiles.includes(snapshot[2]) ? snapshot[2] : 'redacted' }),
  };
  return { reason: 'redacted' };
}

/** Test artifact projection: never serialize the record, actor, brief, checkpoint or result. */
export function handoffE2eDiagnostics(value: unknown) {
  const record = object(value); const failure = object(record.failure);
  return {
    state: choice(record.state, HANDOFF_STATES),
    ...(record.failure && { failure: { step: choice(failure.step, steps), code: choice(failure.code, failureCodes) } }),
    hasCheckpoint: !!record.checkpoint, hasResult: !!record.result,
    history: (Array.isArray(record.history) ? record.history : []).slice(-256).map((entry) => {
      const event = object(entry); const failed = object(event.failure);
      return { state: choice(event.state, HANDOFF_STATES), ...reason(event.reason),
        ...(event.failure && { failure: { step: choice(failed.step, steps), code: choice(failed.code, failureCodes) } }) };
    }),
  };
}
