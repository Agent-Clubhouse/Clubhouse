import { expect, it } from 'vitest';
import { isRemoteDetailsQuery } from './remote-details-query';
import { isRemoteInventoryPage } from './remote-inventory-page';
import { isRemoteAgentDetails, REMOTE_DETAILS_CARD_IDS } from './remote-agent-details';
const selection = 'a'.repeat(64);
const page = () => ({ version: 1, source: 'selected-managed-skills', offset: 100, observedAt: 1, notes: [], state: 'recorded', selection, total: 101, next: null,
  rows: [{ key: 'b'.repeat(64), kind: 'skill', state: 'recorded', name: 'Selected skill', revision: 1, builtin: false }] });
it('binds bounded selected configured metadata queries to source and ordered-selection identity', () => {
  expect(isRemoteDetailsQuery({ card: 'skills-mcp', source: 'selected-managed-skills' })).toBe(true);
  expect(isRemoteDetailsQuery({ card: 'skills-mcp', source: 'selected-managed-skills', offset: 100, selection })).toBe(true);
  for (const patch of [{ offset: 100 }, { offset: 1, selection }, { offset: 4100, selection }, { selection: 'private' }, { projectOffset: 0 }, { source: 'all-library' }, { card: 'connections' }, { path: '/private' }, { grant: true }])
    expect(isRemoteDetailsQuery({ card: 'skills-mcp', source: 'selected-managed-skills', ...patch })).toBe(false);
});
it('discriminates Actions card/source and rejects unrelated card bodies in the common envelope', () => {
  const query = { card: 'actions', source: 'selected-action-relationships', offset: 25, selection };
  expect(isRemoteDetailsQuery(query)).toBe(true);
  for (const patch of [{ card: 'skills-mcp' }, { source: 'selected-managed-skills' }, { selection: undefined }]) expect(isRemoteDetailsQuery({ ...query, ...patch })).toBe(false);
  const inventoryPage = { version: 1, source: query.source, state: 'recorded', offset: 25, selection, next: null, totalRelationships: 26, uniqueActions: 13, observedAt: 1, notes: [], rows: [{ key: 'c'.repeat(64), name: 'Last relationship', group: 'triggered-by', enabled: false, description: 'Message Selected' }] };
  const value = { version: 1, inventoryPages: 1, inventorySources: [query.source], inventoryPageOnly: true, inventoryPage, agentId: 'a1', readOnly: true, readAt: 1, providerId: 'unknown', running: false, status: 'sleeping', spawnedAt: null, sessionId: null, nativeSessionId: null, settings: null,
    cards: REMOTE_DETAILS_CARD_IDS.map((id) => ({ id, title: id, state: 'ok', summary: '', rows: [], notes: [], omitted: 0, observedAt: 1, ...(id !== 'actions' && { requested: false }) })) };
  expect(isRemoteInventoryPage(inventoryPage)).toBe(true); expect(isRemoteAgentDetails(value, 'a1')).toBe(true);
  expect(isRemoteAgentDetails({ ...value, PRIVATE_DEFINITION: 'PRIVATE' }, 'a1')).toBe(false);
  expect(isRemoteAgentDetails({ ...value, cards: value.cards.map((c) => ({ ...c, requested: c.id === 'skills-mcp' ? undefined : false })) }, 'a1')).toBe(false);
});
it('allows only source-appropriate bounded metadata, no content/IDs or fabricated totals', () => {
  expect(isRemoteInventoryPage(page())).toBe(true);
  for (const patch of [{ total: 100 }, { next: 100 }, { selection: undefined }, { source: 'all-library' }, { rows: [{ ...page().rows[0], payload: 'PRIVATE' }] }, { rows: [{ ...page().rows[0], assetId: 'PRIVATE' }] }, { rows: [{ ...page().rows[0], kind: 'mcp' }] }, { rows: [] }]) expect(isRemoteInventoryPage({ ...page(), ...patch })).toBe(false);
  expect(isRemoteInventoryPage({ ...page(), rows: [{ key: 'b'.repeat(64), kind: 'skill', state: 'missing', name: null }] })).toBe(true);
  const unavailable = { version: 1, source: 'selected-managed-skills', offset: 100, observedAt: 1, notes: [], state: 'unavailable', reason: 'changed' };
  expect(isRemoteInventoryPage(unavailable)).toBe(true); expect(isRemoteInventoryPage({ ...unavailable, rows: [] })).toBe(false);
});
