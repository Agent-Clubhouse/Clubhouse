import { expect, it } from 'vitest';
import { isRemoteHelperPage, type RemoteHelperPage } from './remote-helper-page';
import { isRemoteDetailsQuery } from './remote-details-query';
const page = (): RemoteHelperPage => ({ version: 1, source: 'selected-direct-helpers', state: 'ok', offset: 0, next: null, total: 0, liveCount: 0, disposedCount: 0, pendingCount: null, rows: [], pending: [], notes: ['Pending starts unavailable.'] });
it('keeps known zero and unknown counts distinct', () => { expect(isRemoteHelperPage(page())).toBe(true); expect(isRemoteHelperPage({ ...page(), state: 'unavailable', total: null, liveCount: null, disposedCount: null })).toBe(true); expect(isRemoteHelperPage({ ...page(), total: null })).toBe(false); });
it.each([1, -8, 4097, 8.1])('rejects unsafe page arithmetic %s', (offset) => { expect(isRemoteHelperPage({ ...page(), offset })).toBe(false); expect(isRemoteDetailsQuery({ card: 'orchestrate', source: 'helpers', offset })).toBe(false); });
it('keeps the existing Connections schema and adds only selected helper page arguments', () => {
  expect(isRemoteDetailsQuery({ card: 'connections', source: 'helpers', offset: 1, projectOffset: 16 })).toBe(true);
  expect(isRemoteDetailsQuery({ card: 'orchestrate', source: 'helpers', offset: 8 })).toBe(true);
  for (const extra of [{ source: 'outgoing' }, { projectOffset: 1 }, { targetId: 'private' }, { path: '/private' }]) expect(isRemoteDetailsQuery({ card: 'orchestrate', source: 'helpers', offset: 0, ...extra })).toBe(false);
});
it('rejects raw fields, unsupported statuses, and fabricated navigation identities', () => {
  const row = { key: 'opaque', name: 'Helper', projectName: null, status: 'unknown', statusSource: 'unknown', branch: null, failure: 'unknown', disposedAt: null, work: { state: 'unavailable', reason: 'identity' } };
  const selected = { ...page(), total: 1, liveCount: 1, disposedCount: 0, rows: [row] }; expect(isRemoteHelperPage(selected)).toBe(true);
  for (const patch of [{ command: 'PRIVATE' }, { projectPath: '/PRIVATE' }, { status: 'sleeping' }, { target: { agentId: 'agent@host', projectId: 'p' } }, { work: { state: 'recorded', text: 'clean', raw: 'PRIVATE' } }]) expect(isRemoteHelperPage({ ...selected, rows: [{ ...row, ...patch }] })).toBe(false);
});

it('rejects empty beyond-end pages and duplicate row identities', () => {
  expect(isRemoteHelperPage({ ...page(), offset: 8, total: 8, liveCount: 8 })).toBe(false);
  const row = { key: 'duplicate', name: 'Helper', projectName: null, status: 'unknown', statusSource: 'unknown', branch: null, failure: 'unknown', disposedAt: null, work: { state: 'unavailable', reason: 'identity' } };
  expect(isRemoteHelperPage({ ...page(), total: 2, liveCount: 2, rows: [row, row] })).toBe(false);
});
