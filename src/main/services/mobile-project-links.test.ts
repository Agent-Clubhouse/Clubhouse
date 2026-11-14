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
  expect(mobileProjectLinks(a).projectLinks[0].projects).toEqual([{ machine: A, projectId: 'site' }, { machine: B, projectId: 'site' }]);
  // An offline computer stays in the shared group; the phone joins only available catalogs.
  expect(mobileProjectLinks(a).projectLinks[0].id).toMatch(/^[0-9a-f]{64}$/);
  await b.apply({ type: 'keepSeparate', a: 'site', b: `remote||${A}||site` });
  await a.merge(b.records(), B);
  expect(mobileProjectLinks(a).projectLinks).toEqual([]);
  expect(mobileProjectLinks(b).projectLinks).toEqual([]);
});
describe('explicit display decisions', () => {
  it('publishes manual links and removes them after unlink, without publishing negative pairs', async () => {
    const store = replica(A);
    expect(mobileProjectLinks(store).projectLinks).toEqual([]);
    await store.apply({ type: 'link', a: 'site', b: `remote||${B}||unrelated` });
    expect(mobileProjectLinks(store).projectLinks).toHaveLength(1);
    await store.apply({ type: 'unlink', a: 'site' });
    expect(mobileProjectLinks(store).projectLinks).toEqual([]);
    expect(store.records()[0].linked).toBe(false);
  });
});

it('caps whole groups and total references, and marks truncation instead of publishing partial groups', () => {
  const group = (i: number) => [{ machine: A, projectId: `a-${i}` }, { machine: B, projectId: `b-${i}` }];
  const fake = (groups: ReturnType<typeof group>[]) => ({ groups: () => groups }) as unknown as ProjectLinksStore;
  const capped = mobileProjectLinks(fake(Array.from({ length: 201 }, (_, i) => group(i))));
  expect(capped.projectLinks).toHaveLength(200);
  expect(capped.projectLinks.every((g) => g.projects.length === 2)).toBe(true);
  expect(capped.projectLinksTruncated).toBe(true);
  const large = Array.from({ length: 2001 }, (_, i) => ({ machine: A, projectId: `large-${i}` }));
  const refs = mobileProjectLinks(fake([large, group(1)]));
  expect(refs.projectLinks).toHaveLength(1);
  expect(refs.projectLinks[0].projects).toEqual(group(1));
  expect(refs.projectLinksTruncated).toBe(true);
  expect(mobileProjectLinks(fake([group(1)]))).not.toHaveProperty('projectLinksTruncated');
});
