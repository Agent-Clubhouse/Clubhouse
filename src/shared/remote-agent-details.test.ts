import { describe, expect, it } from 'vitest';
import { isRemoteAgentDetails, REMOTE_DETAILS_CARD_IDS } from './remote-agent-details';

const fixture = () => ({ version: 1, agentId: 'a1', readOnly: true, readAt: 1, providerId: 'codex', running: false, status: 'sleeping', spawnedAt: null, sessionId: null, nativeSessionId: null, settings: null,
  cards: REMOTE_DETAILS_CARD_IDS.map((id) => ({ id, title: id, state: 'ok', summary: '', rows: [], notes: [], omitted: 0, observedAt: 1 })) });
describe('remote Details contract', () => {
  it('requires an exact selected agent and complete distinct bounded card states', () => {
    expect(isRemoteAgentDetails(fixture(), 'a1')).toBe(true);
    expect(isRemoteAgentDetails(fixture(), 'other')).toBe(false);
    for (const patch of [{ version: 2 }, { readOnly: false }, { readAt: NaN }, { cards: [] }, { settings: {} }]) {
      expect(isRemoteAgentDetails({ ...fixture(), ...patch }, 'a1')).toBe(false);
    }
    const value = fixture();
    value.cards[1] = value.cards[0];
    expect(isRemoteAgentDetails(value, 'a1')).toBe(false);
  });
  it('rejects malformed entries without throwing and distinguishes errors from verified empty', () => {
    for (const entry of [null, false, {}, { ...fixture().cards[0], rows: [null] }, { ...fixture().cards[0], omitted: -1 }]) {
      const value = fixture();
      (value.cards as unknown[])[0] = entry;
      expect(isRemoteAgentDetails(value, 'a1')).toBe(false);
    }
    const value = fixture();
    value.cards[0].state = 'error';
    expect(isRemoteAgentDetails(value, 'a1')).toBe(true);
    (value.cards[0].rows as unknown[]) = Array(101).fill({ label: 'Name', value: 'Value' });
    expect(isRemoteAgentDetails(value, 'a1')).toBe(false);
  });
});
