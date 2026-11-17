import { expect, it } from 'vitest';
import { handoffTransferDiagnostic, parseHandoffTransferDiagnostic, tagHandoffTransferError } from './handoff-transfer-diagnostics';
it('preserves guard classification without copying error text or private fields', () => {
  const error = new Error('private-path/private-token');
  expect(tagHandoffTransferError(error, 'agreement_binding')).toBe(error);
  expect(handoffTransferDiagnostic(error)).toBe('agreement_binding');
  expect(handoffTransferDiagnostic(tagHandoffTransferError(error, 'sender_authorization'))).toBe('agreement_binding');
  expect(parseHandoffTransferDiagnostic(error.message)).toBe('unknown');
  expect(handoffTransferDiagnostic(new Error(error.message))).toBe('unknown');
  expect(handoffTransferDiagnostic(Object.assign(new Error('private'), { name: 'HandoffSnapshotError', code: 'hash_mismatch' }))).toBe('snapshot_hash_mismatch');
  expect(handoffTransferDiagnostic(Object.assign(new Error('private'), { name: 'HandoffSnapshotError', code: 'private-path' }))).toBe('unknown');
});
