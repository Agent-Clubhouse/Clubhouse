import { expect, it } from 'vitest';
import { handoffE2eDiagnostics } from './handoff-e2e-diagnostics';

it('retains failure stages and known fixture findings without brief, identities or arbitrary paths', () => {
  const secret = 'ghp_' + 'x'.repeat(36);
  const privatePath = ['private-user', 'private-project', 'source.txt'].join('\\');
  const result = handoffE2eDiagnostics({
    state: 'failed', failure: { step: 'verification', code: 'verification_failed' },
    task: { brief: secret }, from: { agentId: secret }, checkpoint: { worktree: privatePath }, result: { worktree: privatePath },
    history: [
      { state: 'offered', by: { address: secret } },
      { state: 'failed', reason: 'Handoff snapshot failed: hash_mismatch (fixtures/selected.bin).' },
      { state: 'failed', reason: `Handoff snapshot failed: secret_blocked (${privatePath}).` },
      { state: 'failed', reason: secret },
    ],
  });
  expect(result.failure).toEqual({ step: 'verification', code: 'verification_failed' });
  expect(result.history).toEqual([
    { state: 'offered', reason: 'not_recorded' },
    { state: 'failed', reason: 'snapshot', snapshotCode: 'hash_mismatch', file: 'fixtures/selected.bin' },
    { state: 'failed', reason: 'snapshot', snapshotCode: 'secret_blocked', file: 'redacted' },
    { state: 'failed', reason: 'redacted' },
  ]);
  expect(JSON.stringify(result)).not.toContain(secret); expect(JSON.stringify(result)).not.toContain(privatePath);
});
it('bounds history and rejects unrecognized diagnostic fields instead of reflecting them', () => {
  const privateValue = 'private-value';
  const result = handoffE2eDiagnostics({ state: privateValue, failure: { step: privateValue, code: privateValue },
    history: Array.from({ length: 300 }, () => ({ state: privateValue, failure: { step: privateValue, code: privateValue }, reason: `Handoff snapshot failed: ${privateValue}.` })),
  });
  expect(result.history).toHaveLength(256); expect(result.state).toBe('unknown');
  expect(JSON.stringify(result)).not.toContain(privateValue);
  expect(handoffE2eDiagnostics(null)).toMatchObject({ state: 'unknown', history: [] });
});
