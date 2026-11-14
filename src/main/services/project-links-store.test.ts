import { describe, expect, it, vi } from 'vitest';
import { ProjectLinksStore } from './project-links-store';
import { applyProjectLinksOp } from '../../shared/project-links';
const A = Array(16).fill('aa').join(':'), B = Array(16).fill('bb').join(':');
const remote = `remote||${B}||copy`;
function replica() {
  let disk = { version: 1 as const, records: [], migrated: [] } as Parameters<ConstructorParameters<typeof ProjectLinksStore>[0]['save']>[0];
  const mirror = { links: [['site', remote]] };
  const save = vi.fn(async (value: typeof disk) => { disk = structuredClone(value); });
  const make = () => new ProjectLinksStore({ read: () => structuredClone(disk), save, self: () => A, legacyMirror: () => mirror, now: () => 100 });
  return { make, save, mirror, disk: () => disk };
}
describe('durable project link replica', () => {
  it('migrates each legacy source once, keeps its values, and preserves tombstones over restart', async () => {
    const f = replica(), store = f.make();
    const legacy = { links: [['site', remote]], keptSeparate: [['site', remote].sort().join('\n')] };
    const original = structuredClone(legacy);
    await store.migrate(legacy);
    expect(store.view().links).toEqual([]);
    expect(legacy).toEqual(original);
    expect(f.mirror.links).toEqual([['site', remote]]);
    await store.apply({ type: 'link', a: 'site', b: remote });
    const restarted = f.make();
    await restarted.migrate(legacy);
    expect(restarted.view().links).toHaveLength(1);
    await restarted.apply({ type: 'unlink', a: 'site' });
    expect(f.make().view().links).toEqual([]);
    expect(f.disk().records[0].linked).toBe(false);
  });
  it('serializes incoming state and local edits, and notifies only after persistence', async () => {
    const f = replica(), store = f.make();
    await store.migrate();
    const changed = vi.fn(); store.onChange(changed);
    let finish!: () => void;
    f.save.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const first = store.apply({ type: 'unlink', a: 'site' });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(changed).not.toHaveBeenCalled();
    const old = applyProjectLinksOp([], { type: 'link', a: 'site', b: remote }, A, 1);
    const second = store.merge(old, B);
    finish(); await first; await second;
    expect(store.view().links).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(1);
  });
  it('rejects a failed save without changing memory, and can retry', async () => {
    const f = replica(), store = f.make();
    await store.migrate();
    f.save.mockRejectedValueOnce(new Error('disk failed'));
    await expect(store.apply({ type: 'unlink', a: 'site' })).rejects.toThrow('disk failed');
    expect(store.view().links).toHaveLength(1);
    await store.apply({ type: 'unlink', a: 'site' });
    expect(store.view().links).toEqual([]);
  });
  it('refuses a queued publication whose pairing is no longer current', async () => {
    const f = replica(), store = f.make();
    await store.migrate();
    const incoming = applyProjectLinksOp(store.records(), { type: 'unlink', a: 'site' }, A, 200);
    await expect(store.merge(incoming, B, () => false)).rejects.toThrow('pairing changed');
    expect(store.view().links).toHaveLength(1);
  });
});
