import { describe, expect, it } from 'vitest';
import { ProjectLinksStore } from './project-links-store';
import { mobileProjectLinks } from './mobile-project-links';
const A = Array(16).fill('aa').join(':'), B = Array(16).fill('bb').join(':');
function replica(self: string) {
  return new ProjectLinksStore({ read: () => ({ version: 1, records: [], migrated: [] }), save: async () => {}, self: () => self, legacyMirror: () => undefined, now: () => 100 });
}
it('gives phones using one or several member computers the same qualified groups and ids', async () => {
  const a = replica(A), b = replica(B);
  await a.apply({ type: 'link', a: 'site', b: `remote||${B}||site` });
  await b.merge(a.records(), A);
  expect(mobileProjectLinks(a)).toEqual(mobileProjectLinks(b));
  expect(mobileProjectLinks(a)[0].projects).toEqual([{ machine: A, projectId: 'site' }, { machine: B, projectId: 'site' }]);
  // An offline computer stays in the shared group; the phone joins only available catalogs.
  expect(mobileProjectLinks(a)[0].id).toMatch(/^[0-9a-f]{64}$/);
  await b.apply({ type: 'keepSeparate', a: 'site', b: `remote||${A}||site` });
  await a.merge(b.records(), B);
  expect(mobileProjectLinks(a)).toEqual([]);
  expect(mobileProjectLinks(b)).toEqual([]);
});
describe('explicit display decisions', () => {
  it('publishes manual links and removes them after unlink, without publishing negative pairs', async () => {
    const store = replica(A);
    expect(mobileProjectLinks(store)).toEqual([]);
    await store.apply({ type: 'link', a: 'site', b: `remote||${B}||unrelated` });
    expect(mobileProjectLinks(store)).toHaveLength(1);
    await store.apply({ type: 'unlink', a: 'site' });
    expect(mobileProjectLinks(store)).toEqual([]);
    expect(store.records()[0].linked).toBe(false);
  });
});
