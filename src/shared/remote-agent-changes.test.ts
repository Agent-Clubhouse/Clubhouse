import { describe, expect, it } from 'vitest';
import { isRemoteAgentChanges, isRemoteChangesQuery, remoteChangesDiffstat, type RemoteAgentChanges } from './remote-agent-changes';
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
  it('accepts optional whole-comparison totals across pages and preserves older host responses', () => {
    const file = { path: 'known', fileKey: 'a'.repeat(64), status: 'modified', additions: 2, deletions: 3, countsKnown: true, binary: false, evidence: 'text' } as const;
    const value = { ...fixture(), files: [file], totalFiles: 51, nextOffset: 50, diffstat: { additions: 7, deletions: 9, knownFiles: 50 } };
    expect(isRemoteAgentChanges(value, 'a1', { scope: 'branch' })).toBe(true);
    expect(isRemoteAgentChanges({ ...value, offset: 50, nextOffset: null }, 'a1', { scope: 'branch', offset: 50 })).toBe(true);
    expect(isRemoteAgentChanges({ ...value, diffstat: undefined }, 'a1', { scope: 'branch' })).toBe(true);
    for (const diffstat of [null, { additions: -1, deletions: 9, knownFiles: 50 }, { additions: Infinity, deletions: 9, knownFiles: 50 },
      { additions: Number.MAX_SAFE_INTEGER + 1, deletions: 9, knownFiles: 50 }, { additions: 7, deletions: 9, knownFiles: 52 },
      { additions: 7, deletions: 9, knownFiles: 0 }, { additions: 1, deletions: 9, knownFiles: 50 },
      { additions: 7, deletions: 2, knownFiles: 50 }, { additions: 7, deletions: 9, knownFiles: 1 },
      { additions: 7, deletions: 9, knownFiles: 1.5 }]) expect(isRemoteAgentChanges({ ...value, diffstat }, 'a1', { scope: 'branch' })).toBe(false);
    expect(isRemoteAgentChanges({ ...value, files: [{ ...file, countsKnown: false }], diffstat: { additions: 7, deletions: 9, knownFiles: 51 } }, 'a1', { scope: 'branch' })).toBe(false);
    expect(isRemoteAgentChanges({ ...fixture(), diffstat: { additions: 0, deletions: 0, knownFiles: 0 } }, 'a1', { scope: 'branch' })).toBe(true);
    expect(isRemoteAgentChanges({ ...fixture(), state: 'no-base', diffstat: { additions: 0, deletions: 0, knownFiles: 0 } }, 'a1', { scope: 'branch' })).toBe(false);
  });
  it('excludes unknown counts and refuses unsafe accumulation rather than rounding or fabricating zero', () => {
    const file = { path: 'known', fileKey: 'a'.repeat(64), status: 'modified', additions: Number.MAX_SAFE_INTEGER, deletions: 1, countsKnown: true, binary: false, evidence: 'text' } as const;
    expect(remoteChangesDiffstat([file, { ...file, countsKnown: false }])).toEqual({ additions: Number.MAX_SAFE_INTEGER, deletions: 1, knownFiles: 1 });
    expect(remoteChangesDiffstat([file, { ...file, additions: 1 }])).toBeUndefined();
    expect(remoteChangesDiffstat([{ ...file, additions: NaN }])).toBeUndefined();
    expect(remoteChangesDiffstat([{ ...file, additions: 0, deletions: Number.MAX_SAFE_INTEGER }, { ...file, additions: 0, deletions: 1 }])).toBeUndefined();
    expect(isRemoteAgentChanges({ ...fixture(), files: [file, { ...file, additions: 1 }], totalFiles: 2, diffstat: { additions: Number.MAX_SAFE_INTEGER, deletions: 2, knownFiles: 2 } }, 'a1', { scope: 'branch' })).toBe(false);
    expect(isRemoteAgentChanges({ ...fixture(), diffstat: { additions: 0, deletions: 0, knownFiles: 0 } }, 'a1', { scope: 'branch', fileKey: 'a'.repeat(64) })).toBe(false);
  });
});
