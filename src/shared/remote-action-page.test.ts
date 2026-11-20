import { expect, it } from 'vitest';
import { isRemoteActionRelationshipPage, type RemoteActionRelationshipPage } from './remote-action-page';
const page = (): RemoteActionRelationshipPage => ({ version: 1, source: 'selected-action-relationships', state: 'recorded', offset: 0, selection: 'a'.repeat(64), next: null, totalRelationships: 0, uniqueActions: 0, rows: [], observedAt: 1, notes: [] });
it('distinguishes recorded zero from unavailable without rows/counts', () => {
  expect(isRemoteActionRelationshipPage(page())).toBe(true);
  const unavailable = { version: 1, source: 'selected-action-relationships', state: 'unavailable', offset: 0, reason: 'changed', observedAt: 1, notes: ['Refresh the selected relationships.'] };
  expect(isRemoteActionRelationshipPage(unavailable)).toBe(true); expect(isRemoteActionRelationshipPage({ ...unavailable, rows: [] })).toBe(false);
});
it.each([{ offset: 1 }, { offset: 4100 }, { selection: 'raw-action-id' }, { next: 25 }, { totalRelationships: 1 }, { uniqueActions: 1 }, { source: 'all-actions' }, { workflow: 'PRIVATE' }])('rejects malformed/expanded page fields %#', (extra) => { expect(isRemoteActionRelationshipPage({ ...page(), ...extra })).toBe(false); });
it('accepts existing short descriptions/outcome/time and rejects underlying definition or private row fields', () => {
  const row = { key: 'b'.repeat(64), name: 'Action', group: 'owned', enabled: true, description: 'When Selected sleeps → Notify you', lastRun: { outcome: 'done', startedAt: 0 } };
  const selected = { ...page(), rows: [row], totalRelationships: 1, uniqueActions: 1 }; expect(isRemoteActionRelationshipPage(selected)).toBe(true);
  for (const patch of [{ actionId: 'PRIVATE' }, { steps: [] }, { args: {} }, { lastRun: { outcome: 'done', startedAt: Number.MAX_SAFE_INTEGER } }, { lastRun: { outcome: 'done', history: [] } }, { enabled: null }]) expect(isRemoteActionRelationshipPage({ ...selected, rows: [{ ...row, ...patch }] })).toBe(false);
  expect(isRemoteActionRelationshipPage({ ...selected, totalRelationships: 2, rows: [row, row] })).toBe(false);
});
