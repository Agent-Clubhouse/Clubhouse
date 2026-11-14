import { describe, expect, it } from 'vitest';
import { applyProjectLinksOp, legacyProjectLinkRecords, mergeProjectLinkRecords, parseProjectLinkRecords, projectLinkGroups, projectLinksView } from './project-links';
const A = Array(16).fill('aa').join(':'), B = Array(16).fill('bb').join(':'), C = Array(16).fill('cc').join(':');
const remote = (m: string, p: string) => `remote||${m}||${p}`;
const linked = () => applyProjectLinksOp([], { type: 'link', a: 'site', b: remote(B, 'copy') }, A, 100);
describe('network-shared project link pairs', () => {
  it('uses machine-qualified identities, including projects with the same local id', () => {
    const records = applyProjectLinksOp([], { type: 'link', a: 'site', b: remote(B, 'site') }, A, 100);
    expect(projectLinksView(records, A, 1).links).toEqual([['site', remote(B, 'site')]]);
    expect(projectLinksView(records, B, 1).links).toEqual([[remote(A, 'site'), 'site']]);
  });
  it('converges regardless of delivery order, duplicates and an offline replica returning', () => {
    const original = linked();
    const removed = applyProjectLinksOp(original, { type: 'unlink', a: remote(A, 'site') }, B, 200);
    expect(projectLinkGroups(mergeProjectLinkRecords(original, removed))).toEqual([]);
    expect(mergeProjectLinkRecords(removed, original)).toBe(removed);
    const again = applyProjectLinksOp(removed, { type: 'link', a: 'copy', b: remote(A, 'site') }, B, 50);
    expect(again[0].at).toBeGreaterThan(removed[0].at);
    expect(projectLinkGroups(mergeProjectLinkRecords(removed, again))).toHaveLength(1);
    expect(mergeProjectLinkRecords(original, again)).toEqual(mergeProjectLinkRecords(removed, again));
  });
  it('migrates accepted suggestions and manual groups without inferring git remotes; Keep separate wins untimed conflicts', () => {
    const first = legacyProjectLinkRecords({ links: [['site', remote(B, 'copy')], ['manual', remote(C, 'folder')]] }, A);
    const separate = legacyProjectLinkRecords({ links: [], keptSeparate: [remote(A, 'site') + '\ncopy'] }, B);
    expect(mergeProjectLinkRecords(first, separate)).toEqual(mergeProjectLinkRecords(separate, first));
    const merged = mergeProjectLinkRecords(first, separate);
    expect(projectLinkGroups(merged)).toEqual([[{ machine: A, projectId: 'manual' }, { machine: C, projectId: 'folder' }]]);
    expect(projectLinksView(merged, B, 0).keptSeparate).toContain([remote(A, 'site'), 'copy'].sort().join('\n'));
    // A fresh Link explicitly replaces the old separation.
    expect(projectLinkGroups(applyProjectLinksOp(merged, { type: 'link', a: 'site', b: remote(B, 'copy') }, A, 1))).toHaveLength(2);
  });
  it('keeps a new unlink when an old computer first migrates its legacy links', () => {
    const removed = applyProjectLinksOp(linked(), { type: 'split', a: 'site' }, A, 200);
    const old = legacyProjectLinkRecords({ links: [['copy', remote(A, 'site')]] }, B);
    expect(mergeProjectLinkRecords(removed, old)).toBe(removed);
  });
  it('does not restore a kept-separate pair through a concurrent third-project link', () => {
    const base = linked();
    const merge = applyProjectLinksOp(base, { type: 'link', a: remote(A, 'site'), b: 'third' }, C, 200);
    const separate = applyProjectLinksOp(base, { type: 'keepSeparate', a: 'site', b: remote(B, 'copy') }, A, 201);
    const records = mergeProjectLinkRecords(merge, separate);
    for (const group of projectLinkGroups(records)) {
      expect(group.some((p) => p.machine === A) && group.some((p) => p.machine === B)).toBe(false);
    }
    expect(projectLinkGroups(records)).toEqual(projectLinkGroups(mergeProjectLinkRecords(separate, merge)));
  });
  it('breaks equal-clock ties deterministically, with separation safer than link', () => {
    const yes = linked();
    const no = yes.map((r) => ({ ...r, linked: false, by: B }));
    expect(mergeProjectLinkRecords(yes, no)).toEqual(no);
    expect(mergeProjectLinkRecords(no, yes)).toBe(no);
  });
  it('rejects malformed records instead of storing arbitrary input', () => {
    for (const raw of [[{ ...linked()[0], extra: true }], [{ ...linked()[0], at: Infinity }], [{ ...linked()[0], by: 'not-a-machine' }], [{ ...linked()[0], projects: [{ machine: A, projectId: '/bad\npath' }, { machine: B, projectId: 'x' }] }]]) {
      expect(() => parseProjectLinkRecords(raw)).toThrow();
    }
  });
});
