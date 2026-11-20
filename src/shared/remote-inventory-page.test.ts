import { expect, it } from 'vitest';
import { isRemoteDetailsQuery } from './remote-details-query';
import { isRemoteInventoryPage } from './remote-inventory-page';
const selection = 'a'.repeat(64);
const page = () => ({ version: 1, source: 'selected-managed-skills', offset: 100, observedAt: 1, notes: [], state: 'recorded', selection, total: 101, next: null,
  rows: [{ key: 'b'.repeat(64), kind: 'skill', state: 'recorded', name: 'Selected skill', revision: 1, builtin: false }] });
it('binds bounded selected configured metadata queries to source and ordered-selection identity', () => {
  expect(isRemoteDetailsQuery({ card: 'skills-mcp', source: 'selected-managed-skills' })).toBe(true);
  expect(isRemoteDetailsQuery({ card: 'skills-mcp', source: 'selected-managed-skills', offset: 100, selection })).toBe(true);
  for (const patch of [{ offset: 100 }, { offset: 1, selection }, { offset: 4100, selection }, { selection: 'private' }, { projectOffset: 0 }, { source: 'all-library' }, { card: 'connections' }, { path: '/private' }, { grant: true }])
    expect(isRemoteDetailsQuery({ card: 'skills-mcp', source: 'selected-managed-skills', ...patch })).toBe(false);
});
it('allows only source-appropriate bounded metadata, no content/IDs or fabricated totals', () => {
  expect(isRemoteInventoryPage(page())).toBe(true);
  for (const patch of [{ total: 100 }, { next: 100 }, { selection: undefined }, { source: 'all-library' }, { rows: [{ ...page().rows[0], payload: 'PRIVATE' }] }, { rows: [{ ...page().rows[0], assetId: 'PRIVATE' }] }, { rows: [{ ...page().rows[0], kind: 'mcp' }] }, { rows: [] }]) expect(isRemoteInventoryPage({ ...page(), ...patch })).toBe(false);
  expect(isRemoteInventoryPage({ ...page(), rows: [{ key: 'b'.repeat(64), kind: 'skill', state: 'missing', name: null }] })).toBe(true);
  const unavailable = { version: 1, source: 'selected-managed-skills', offset: 100, observedAt: 1, notes: [], state: 'unavailable', reason: 'changed' };
  expect(isRemoteInventoryPage(unavailable)).toBe(true); expect(isRemoteInventoryPage({ ...unavailable, rows: [] })).toBe(false);
});
