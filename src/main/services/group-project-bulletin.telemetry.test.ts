import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/tmp/test-clubhouse-tel' } }));
const store = vi.hoisted(() => new Map<string, string>());
vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockImplementation(async (p: string) => { if (!store.has(p)) throw new Error('ENOENT'); }),
  readFile: vi.fn().mockImplementation(async (p: string) => { const d = store.get(p); if (!d) throw new Error('ENOENT'); return d; }),
  writeFile: vi.fn().mockImplementation(async (p: string, c: string) => { store.set(p, c); }),
  rename: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
const counts = vi.hoisted(() => [] as Array<{ name: string; result: unknown }>);
vi.mock('../telemetry/facade', () => ({
  tel: {
    count: (name: string, _v: number, attrs: Array<{ key: string; value: unknown }> = []) => counts.push({ name, result: attrs[0]?.value }),
    event: vi.fn(),
  },
}));

import { _resetAllBoardsForTesting, getBulletinBoard } from './group-project-bulletin';

beforeEach(() => {
  store.clear();
  counts.length = 0;
  _resetAllBoardsForTesting();
});

const results = () => counts.filter((c) => c.name === 'clubhouse.group.bulletin.posts').map((c) => c.result);

describe('bulletin post telemetry', () => {
  it('counts posts by result: ok, own-topic eviction, board-wide eviction, rejected', async () => {
    const board = getBulletinBoard('proj_tel');
    board.setLimits(2, 3);
    await board.postMessage('a', 'one', 'hello');
    await board.postMessage('a', 'one', 'hello');
    await board.postMessage('a', 'one', 'hello'); // topic cap 2 → drops one of its own
    await board.postMessage('a', 'two', 'hello');
    await board.postMessage('a', 'two', 'hello'); // board cap 3 → drops from another topic
    await expect(board.postMessage('a', 'one', 'x'.repeat(200 * 1024))).rejects.toThrow('byte limit');
    expect(results()).toEqual(['ok', 'ok', 'evicted_message', 'ok', 'evicted_topic', 'rejected']);
  });
});
