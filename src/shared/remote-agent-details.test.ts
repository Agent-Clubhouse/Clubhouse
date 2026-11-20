import { describe, expect, it } from 'vitest';
import { isRemoteAgentDetails, REMOTE_DETAILS_CARD_IDS } from './remote-agent-details';

const fixture = () => ({ version: 1, agentId: 'a1', readOnly: true, readAt: 1, providerId: 'codex', running: false, status: 'sleeping', spawnedAt: null, sessionId: null, nativeSessionId: null, settings: null,
  cards: REMOTE_DETAILS_CARD_IDS.map((id) => ({ id, title: id, state: 'ok', summary: '', rows: [], notes: [], omitted: 0, observedAt: 1 })) });
describe('remote Details contract', () => {
  it('requires an exact selected agent and complete distinct bounded card states', () => {
    expect(isRemoteAgentDetails(fixture(), 'a1')).toBe(true);
    expect(isRemoteAgentDetails(fixture(), 'other')).toBe(false);
    for (const patch of [{ version: 2 }, { readOnly: false }, { readAt: NaN }, { providerId: '' }, { providerLabel: '' }, { providerLabel: 'x'.repeat(2049) }, { cards: [] }, { settings: {} }]) {
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
  it('accepts selected-agent canvas navigation only on the Canvases card with bounded opaque identities', () => {
    const value = fixture();
    const canvas = value.cards.find((c) => c.id === 'canvases')!;
    const nav = { label: 'Host Home', value: 'Home', canvas: { scope: 'app', canvasId: 'board', viewId: 'view' } };
    (canvas.rows as unknown[]) = [nav];
    expect(isRemoteAgentDetails(value, 'a1')).toBe(true);
    for (const invalid of [null, {}, { ...nav.canvas, scope: 'other' }, { ...nav.canvas, viewId: '' }, { ...nav.canvas, canvasId: 'x'.repeat(2049) }]) {
      (canvas.rows as unknown[]) = [{ ...nav, canvas: invalid }];
      expect(isRemoteAgentDetails(value, 'a1')).toBe(false);
    }
    (canvas.rows as unknown[]) = [];
    (value.cards[0].rows as unknown[]) = [nav];
    expect(isRemoteAgentDetails(value, 'a1')).toBe(false);
  });  it('accepts only bounded display-safe action fields on Actions, preserving old plain rows', () => {
    const value = fixture(); const card = value.cards.find((c) => c.id === 'actions')!;
    const action = { group: 'owned', enabled: false, description: 'Wake Selected', lastRun: { outcome: 'done', startedAt: 1000 } };
    (card.rows as unknown[]) = [{ label: 'Name', value: 'Off · Wake Selected', action }]; expect(isRemoteAgentDetails(value, 'a1')).toBe(true);
    for (const invalid of [null, {}, { ...action, group: 'unrelated' }, { ...action, enabled: 'on' }, { ...action, description: 'x'.repeat(2049) }, { ...action, steps: [] }, { ...action, lastRun: null }, { ...action, lastRun: { outcome: 'other' } }, { ...action, lastRun: { outcome: 'done', startedAt: NaN } }, { ...action, lastRun: { outcome: 'done', startedAt: Number.MAX_SAFE_INTEGER } }, { ...action, lastRun: { outcome: 'done', startedAt: -1 } }, { ...action, lastRun: { outcome: 'done', reason: 'PRIVATE_REASON' } }]) {
      (card.rows as unknown[]) = [{ label: 'Name', value: 'Value', action: invalid }]; expect(isRemoteAgentDetails(value, 'a1')).toBe(false);
    }
    (card.rows as unknown[]) = []; (value.cards[0].rows as unknown[]) = [{ label: 'Name', value: 'Value', action }]; expect(isRemoteAgentDetails(value, 'a1')).toBe(false);
    (value.cards[0].rows as unknown[]) = []; (card.rows as unknown[]) = [{ label: 'Legacy', value: 'On · description · done' }]; expect(isRemoteAgentDetails(value, 'a1')).toBe(true);
  });

});

it('accepts additive supported source lists only with bounded unique known source identities and page capability', () => {
  const value = { ...fixture(), connectionPages: 1, connectionPageSources: ['outgoing', 'tool-records'] };
  expect(isRemoteAgentDetails(value, 'a1')).toBe(true);
  for (const connectionPageSources of [['outgoing', 'outgoing'], ['collect'], ['x'.repeat(300)], null, {}]) expect(isRemoteAgentDetails({ ...value, connectionPageSources }, 'a1')).toBe(false);
  expect(isRemoteAgentDetails({ ...value, connectionPages: undefined }, 'a1')).toBe(false);
});
