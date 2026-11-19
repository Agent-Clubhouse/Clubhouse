import { describe, expect, it } from 'vitest';
import { isRemoteAgentChanges, isRemoteChangesQuery, type RemoteAgentChanges } from './remote-agent-changes';
const fixture = (): RemoteAgentChanges => ({ version: 1, readOnly: true, agentId: 'a1', observedAt: 1, scope: 'branch', state: 'ok', branch: 'feature', base: 'main', sessionId: null, turnId: null, live: true, shared: false,
  files: [], totalFiles: 0, offset: 0, nextOffset: null, uncompared: 0, skippedLarge: [], skippedRepos: [], skippedOmitted: 0 });
describe('selected-agent Changes display contract', () => {
  it('accepts only scope/page/opaque-key requests; paths/refs/session discovery are not inputs', () => {
    for (const q of [{ scope: 'branch' }, { scope: 'session', offset: 50 }, { scope: 'turn', fileKey: 'a'.repeat(64) }]) expect(isRemoteChangesQuery(q)).toBe(true);
    for (const q of [null, [], { scope: 'branch', cwd: '/private' }, { scope: 'session', sessionId: 'other' }, { scope: 'branch', offset: -1 }, { scope: 'turn', fileKey: '../file' }, { scope: 'other' }]) expect(isRemoteChangesQuery(q)).toBe(false);
  });
  it('fences exact agent/scope/page and bounded evidence, including unknown rather than zero counts', () => {
    expect(isRemoteAgentChanges(fixture(), 'a1', { scope: 'branch' })).toBe(true);
    for (const patch of [{ agentId: 'other' }, { scope: 'turn' }, { version: 2 }, { files: [null] }, { skippedLarge: Array(51).fill('file') }, { uncompared: -1 }, { nextOffset: 50 }, { offset: 1 }]) expect(isRemoteAgentChanges({ ...fixture(), ...patch }, 'a1', { scope: 'branch' })).toBe(false);
    const file = { path: 'file', fileKey: 'a'.repeat(64), status: 'unknown', additions: 0, deletions: 0, countsKnown: false, binary: false, evidence: 'unreadable' };
    expect(isRemoteAgentChanges({ ...fixture(), files: [file], totalFiles: 1 }, 'a1', { scope: 'branch' })).toBe(true);
  });
  it('accepts a patch only for the requested opaque key and enforces text bounds and redaction provenance shape', () => {
    const fileKey = 'a'.repeat(64);
    const value = { ...fixture(), patch: { fileKey, state: 'text', text: 'safe', redacted: true } };
    expect(isRemoteAgentChanges(value, 'a1', { scope: 'branch', fileKey })).toBe(true);
    expect(isRemoteAgentChanges(value, 'a1', { scope: 'branch' })).toBe(false);
    for (const patch of [{ ...value.patch, fileKey: 'b'.repeat(64) }, { ...value.patch, text: 'x'.repeat(128 * 1024 + 1) }, { ...value.patch, redacted: 'yes' }]) expect(isRemoteAgentChanges({ ...value, patch }, 'a1', { scope: 'branch', fileKey })).toBe(false);
  });
});
