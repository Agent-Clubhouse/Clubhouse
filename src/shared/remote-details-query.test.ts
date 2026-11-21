import { expect, it } from 'vitest';
import { isRemoteDetailsQuery, isRemoteConnectionPage, REMOTE_CONNECTION_PAGE_SOURCES } from './remote-details-query';
it('admits only bounded selected-source continuation, with no paths, discovery, or duplicate/extra fields', () => {
  for (const source of REMOTE_CONNECTION_PAGE_SOURCES) expect(isRemoteDetailsQuery({ card: 'connections', source, offset: 4096 })).toBe(true);
  for (const extra of [{ offset: -1 }, { offset: 4097 }, { offset: 1.5 }, { offset: '1' }, { projectOffset: 1 }, { projectPath: '/private' }, { agentId: 'other' }, { source: 'collect' }, { card: 'settings' }])
    expect(isRemoteDetailsQuery({ card: 'connections', source: 'sources', ...extra })).toBe(false);
  expect(isRemoteDetailsQuery({ card: 'connections', source: 'helpers', projectOffset: 16, offset: 8 })).toBe(true);
  expect(isRemoteDetailsQuery({ card: 'connections', source: 'tool-records', projectOffset: 16, offset: 8 })).toBe(true);
});
it('binds the returned page to a forward bounded continuation and explicit completeness', () => {
  const page = { source: 'helpers', projectOffset: 0, offset: 8, next: { projectOffset: 16, offset: 0 }, known: 19, complete: false };
  expect(isRemoteConnectionPage(page)).toBe(true);
  for (const extra of [{ next: { projectOffset: 0, offset: 8 } }, { next: { projectOffset: 0, offset: 0 } }, { next: { projectOffset: 16, offset: 4097 } }, { next: { projectOffset: 16, offset: 0, private: true } }, { known: -1 }, { complete: undefined }, { raw: 'PRIVATE' }]) expect(isRemoteConnectionPage({ ...page, ...extra })).toBe(false);
});
