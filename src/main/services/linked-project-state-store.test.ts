import { describe, expect, it, vi } from 'vitest';

vi.mock('./log-service', () => ({ appLog: vi.fn() }));

import { LinkedProjectStateStore } from './linked-project-state-store';
import { LINKED_PROJECT_STATE_PAGE_SIZE, type LinkedProjectStateRecord } from '../../shared/linked-project-state';

const A = Array(16).fill('aa').join(':'), B = Array(16).fill('bb').join(':');
const rec = (projectId: string, at: number, value = true): LinkedProjectStateRecord => ({ project: { machine: B, projectId }, field: 'pinned', value, at, by: A });

function replica() {
  let disk: { version: 1; records: LinkedProjectStateRecord[] } = { version: 1, records: [] };
  const save = vi.fn(async (value: typeof disk) => { disk = structuredClone(value); });
  const make = () => new LinkedProjectStateStore({ read: () => structuredClone(disk), save, now: () => Date.now() });
  return { make, save, disk: () => disk };
}

describe('linked project state replica', () => {
  it('keeps the newest record per project and field across restarts, and notifies only after saving', async () => {
    const f = replica(), store = f.make();
    const listener = vi.fn(() => expect(f.save).toHaveBeenCalled());
    store.onChange(listener);
    await store.write([rec('p', 5)]);
    await store.merge([rec('p', 3, false)], B);
    expect(listener).toHaveBeenCalledTimes(1);
    await store.merge([rec('p', 9, false)], B);
    expect(listener).toHaveBeenLastCalledWith({ source: B, recordsChanged: true });
    expect(f.make().records()).toEqual([rec('p', 9, false)]);
  });

  it('refuses malformed records and drops ones clocked a day ahead', async () => {
    const store = replica().make();
    expect(() => store.merge([{ project: { machine: B, projectId: 'p' }, field: 'nope', value: true, at: 1, by: A }], B)).toThrow();
    await store.merge([rec('far', Date.now() + 3 * 86_400_000), rec('ok', 1)], B);
    expect(store.records().map((r) => r.project.projectId)).toEqual(['ok']);
  });

  it('pages by key with a cursor', async () => {
    const store = replica().make();
    await store.write(Array.from({ length: LINKED_PROJECT_STATE_PAGE_SIZE + 5 }, (_, i) => rec(`p${String(i).padStart(4, '0')}`, 1)));
    const first = store.page();
    expect(first.records).toHaveLength(LINKED_PROJECT_STATE_PAGE_SIZE);
    const second = store.page(first.next);
    expect(second.records).toHaveLength(5);
    expect(second.next).toBeUndefined();
  });
});
