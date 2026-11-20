import { expect, it } from 'vitest';
import { isRemoteCanvasMembershipPage, isRemoteCanvasMembershipQuery } from './remote-canvas-membership-page';
const row = { key: 'a'.repeat(64), name: 'Board', scope: 'project', canvasId: 'board', viewId: 'view' };
const page = { version: 1, source: 'selected-canvas-memberships', agentId: 'a1', projectId: 'p1', offset: 0, observedAt: 1, notes: [], state: 'recorded', selection: 'b'.repeat(64), total: 1, next: null, rows: [row] };
it('accepts only the fixed selected source and aligned bounded continuation with opaque selection', () => {
  expect(isRemoteCanvasMembershipQuery({ card: 'canvases', source: page.source })).toBe(true);
  expect(isRemoteCanvasMembershipQuery({ card: 'canvases', source: page.source, offset: 25, selection: page.selection })).toBe(true);
  for (const extra of [{ offset: 1 }, { offset: 25 }, { offset: 4100, selection: page.selection }, { root: '/unrelated' }, { canvasId: 'other' }, { scope: 'app' }, { selection: 'not-opaque' }]) expect(isRemoteCanvasMembershipQuery({ card: 'canvases', source: page.source, ...extra })).toBe(false);
});
it('validates page completeness and real membership tuples without allowing payloads or empty unknown totals', () => {
  expect(isRemoteCanvasMembershipPage(page)).toBe(true);
  const unavailable = { version: 1, source: page.source, agentId: 'a1', projectId: 'p1', offset: 0, observedAt: 1, notes: [], state: 'unavailable', reason: 'unreadable' };
  expect(isRemoteCanvasMembershipPage(unavailable)).toBe(true);
  expect(isRemoteCanvasMembershipPage({ ...unavailable, rows: [], total: 0 })).toBe(false);
  for (const change of [{ rows: [{ ...row, contents: 'PRIVATE' }] }, { rows: [] }, { total: 0 }, { next: 25 }, { observedAt: NaN }, { rows: [{ ...row, scope: 'other' }] }, { rows: [{ ...row, viewId: '' }] }, { extraAuthority: true }]) expect(isRemoteCanvasMembershipPage({ ...page, ...change })).toBe(false);
});
