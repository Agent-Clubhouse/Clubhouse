import { expect, it } from 'vitest';
import { selectedConnectionPageEnvelope } from './remote-details-presentation';
import { isRemoteAgentDetails, REMOTE_DETAILS_CARD_IDS, REMOTE_DETAILS_MAX_BYTES, type RemoteAgentDetails } from '../../shared/remote-agent-details';
const fixture = (): RemoteAgentDetails => ({ version: 1, connectionPages: 1, connectionPageEnvelope: 1, agentId: 'a1', readOnly: true, readAt: 1, providerId: 'codex', running: false, status: 'sleeping', spawnedAt: null, sessionId: null, nativeSessionId: null, settings: null,
  cards: REMOTE_DETAILS_CARD_IDS.map((id) => ({ id, title: id, state: 'ok', summary: 'Section', rows: [{ label: 'Original field', value: 'Original value' }], notes: [], omitted: 0, observedAt: 1, ...(id === 'connections' && { connectionPage: { source: 'outgoing', offset: 0, projectOffset: 0, known: 2, complete: true, next: null } }) })) });
it('keeps requested rows and explicitly marks other card bodies not requested, preserving full default semantics until invoked', () => {
  const value = fixture(); expect(isRemoteAgentDetails(value, 'a1')).toBe(true); expect(value.cards.every((c) => c.requested === undefined && c.rows.length === 1)).toBe(true);
  selectedConnectionPageEnvelope(value); expect(isRemoteAgentDetails(value, 'a1')).toBe(true); expect(value.connectionPageOnly).toBe(true); expect(value.cards.find((c) => c.id === 'connections')?.rows).toHaveLength(1);
  for (const c of value.cards.filter((c) => c.id !== 'connections')) { expect(c.requested).toBe(false); expect(c.rows).toEqual([]); expect(c.notes).toEqual([]); expect(c.omitted).toBe(1); expect(c.summary).toContain('Not included'); }
  expect(value.settings).toBeNull(); expect(value.providerEvidence).toBeUndefined();
});
it('bounds real UTF8 field bytes without deleting any requested field or pretending field text is complete', () => {
  const value = fixture(), c = value.cards.find((c) => c.id === 'connections')!; c.rows = Array.from({ length: 100 }, () => ({ label: '😀'.repeat(1024), value: '😀'.repeat(1024) })); c.notes = Array.from({ length: 20 }, () => '😀'.repeat(1024));
  selectedConnectionPageEnvelope(value); expect(c.rows).toHaveLength(100); expect(c.omitted).toBe(0); expect(c.rows.every((r) => r.label.includes('text truncated') && r.value.includes('text truncated'))).toBe(true); expect(c.notes.join(' ')).toContain('field text'); expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(REMOTE_DETAILS_MAX_BYTES); expect(isRemoteAgentDetails(value, 'a1')).toBe(true);
});
it('rejects incomplete/malformed page-only claims without throwing and keeps an unavailable page explicitly unavailable', () => {
  const value = fixture(); selectedConnectionPageEnvelope(value);
  for (const patch of [{ connectionPages: undefined }, { connectionPageEnvelope: undefined }, { connectionPageOnly: false }, { settings: {} }, { cards: [null] }, { cards: value.cards.map((c) => c.id === 'settings' ? { ...c, requested: undefined } : c) }, { cards: value.cards.map((c) => c.id === 'settings' ? { ...c, notes: ['PRIVATE_UNREQUESTED'] } : c) }]) expect(isRemoteAgentDetails({ ...value, ...patch }, 'a1')).toBe(false);
  const unavailable = fixture(); delete unavailable.cards.find((c) => c.id === 'connections')!.connectionPage; selectedConnectionPageEnvelope(unavailable); expect(unavailable.connectionPageOnly).toBeUndefined(); expect(unavailable.cards.every((c) => c.requested === undefined)).toBe(true);
});
