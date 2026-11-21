import { expect, it } from 'vitest';
import { quarantineFailureCapture } from './handoff-quarantine-diagnostics';

it('retains closed failure evidence while discarding arbitrary text, identities and invalid fields', () => {
  const capture = quarantineFailureCapture();
  const secret = 'private-path-error-identity';
  capture.record('core:git', secret, { failure: secret });
  capture.record('core:handoff', 'Handoff quarantine root rejected', {
    failure: 'verify:timeout', attempt: 1, created: true, elapsedMs: 20_001,
    path: secret, error: secret, identity: secret,
  });
  capture.record('core:handoff', 'Handoff quarantine root rejected', {
    failure: secret, attempt: 4, created: secret, recovery: true, elapsedMs: Infinity,
  });
  capture.record('core:handoff', 'Handoff quarantine allocation rejected', {
    eligible: 1, canonical: 1, fitting: 1, admitted: false, elapsedMs: 20_002,
  });
  expect(capture.snapshot()).toEqual({ events: [
    { event: 'root_rejected', failure: 'verify:timeout', attempt: 1, created: true, elapsedMs: 20_001 },
    { event: 'root_rejected', recovery: true },
    { event: 'allocation_rejected', eligible: 1, canonical: 1, fitting: 1, admitted: false, elapsedMs: 20_002 },
  ], dropped: 0 });
  expect(JSON.stringify(capture.snapshot())).not.toContain(secret);
});

it('bounds retained output and snapshots do not mutate the collector', () => {
  const capture = quarantineFailureCapture();
  for (let i = 0; i < 40; i++) capture.record('core:handoff', 'Handoff quarantine root rejected', { failure: 'child:busy' });
  const snapshot = capture.snapshot();
  expect(snapshot.events).toHaveLength(32);
  expect(snapshot.dropped).toBe(8);
  snapshot.events[0].failure = 'changed';
  expect(capture.snapshot().events[0].failure).toBe('child:busy');
});
