import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import * as path from 'path';
import { DEFAULT_FILE_SECONDS, UNIT_FILE_SECONDS, partitionByWeight } from './unit-shards.mjs';
import type { TestSpecification, Vitest } from 'vitest/node';
import { UnitShardSequencer, specKey } from './unit-sequencer';

const ROOT = path.resolve(__dirname, '..');

describe('partitionByWeight', () => {
  const files = Array.from({ length: 50 }, (_, i) => `src/f${i}.test.ts`);
  const seconds = { 'src/f3.test.ts': 40, 'src/f7.test.ts': 30, 'src/f11.test.ts': 20 };

  it('puts every file in exactly one shard', () => {
    for (const count of [1, 2, 3, 4]) {
      const shards = partitionByWeight(files, count, seconds);
      expect(shards).toHaveLength(count);
      expect(shards.flat().sort()).toEqual([...files].sort());
    }
  });

  it('gives the same split whatever order the files come in', () => {
    const reversed = [...files].reverse();
    const shuffled = [...files].sort((a, b) => (a.length - b.length) || b.localeCompare(a));
    expect(partitionByWeight(reversed, 3, seconds)).toEqual(partitionByWeight(files, 3, seconds));
    expect(partitionByWeight(shuffled, 3, seconds)).toEqual(partitionByWeight(files, 3, seconds));
  });

  it('spreads the heavy files and evens out the load', () => {
    const shards = partitionByWeight(files, 2, seconds);
    const load = (s: string[]) => s.reduce((sum, f) => sum + (seconds[f as keyof typeof seconds] ?? DEFAULT_FILE_SECONDS), 0);
    expect(shards[0]).toContain('src/f3.test.ts');
    expect(shards[1]).toContain('src/f7.test.ts');
    expect(Math.abs(load(shards[0]) - load(shards[1]))).toBeLessThanOrEqual(DEFAULT_FILE_SECONDS);
  });

  it('counts a file listed twice once', () => {
    expect(partitionByWeight(['a', 'a', 'b'], 2, {})).toEqual([['a'], ['b']]);
  });

  it('leaves a shard empty when there are more shards than files', () => {
    expect(partitionByWeight(['a'], 3, {})).toEqual([['a'], [], []]);
  });

  it('rejects a shard count that is not a positive integer', () => {
    expect(() => partitionByWeight(files, 0)).toThrow(/positive integer/);
    expect(() => partitionByWeight(files, 1.5)).toThrow(/positive integer/);
  });
});

describe('UNIT_FILE_SECONDS', () => {
  it('names test files by repo-relative path with forward slashes', () => {
    // A name that no longer matches a file is only ignored, so a rename doesn't fail here.
    expect(Object.keys(UNIT_FILE_SECONDS).filter((f) => f.includes('\\') || f.startsWith('/') || !/\.test\.tsx?$/.test(f))).toEqual([]);
  });

  it('mostly names files that exist, so the table is fresh enough to balance', () => {
    const names = Object.keys(UNIT_FILE_SECONDS);
    const existing = names.filter((f) => existsSync(path.join(ROOT, f)));
    expect(existing.length).toBeGreaterThanOrEqual(names.length / 2);
  });

  it('weighs no file below the default', () => {
    expect(Object.values(UNIT_FILE_SECONDS).filter((s) => !(s >= DEFAULT_FILE_SECONDS))).toEqual([]);
  });
});

describe('specKey', () => {
  it('is the repo-relative path with forward slashes', () => {
    expect(specKey(ROOT, path.join(ROOT, 'src', 'main', 'a.test.ts'))).toBe('src/main/a.test.ts');
  });
});

describe('UnitShardSequencer', () => {
  const heavy = Object.keys(UNIT_FILE_SECONDS).slice(0, 4);
  const light = Array.from({ length: 20 }, (_, i) => `src/light${i}.test.ts`);
  const spec = (file: string, groupOrder = 0) =>
    ({ moduleId: path.join(ROOT, file), project: { name: 'main', config: { sequence: { groupOrder }, isolate: true } } }) as unknown as TestSpecification;
  const sequencer = (shard?: { index: number; count: number }) =>
    new UnitShardSequencer({
      config: { root: ROOT, shard },
      cache: { getFileTestResults: () => undefined, getFileStats: () => undefined },
    } as unknown as Vitest);
  const key = (s: TestSpecification) => specKey(ROOT, s.moduleId);

  it('gives each spec to exactly one shard', async () => {
    const specs = [...light, ...heavy].map((f) => spec(f));
    const shards = await Promise.all([1, 2, 3].map((index) => sequencer({ index, count: 3 }).shard(specs)));
    expect(shards.flat().map(key).sort()).toEqual([...light, ...heavy].sort());
  });

  it('starts the heaviest files first in a sharded run, within groupOrder', async () => {
    const specs = [spec(light[0]), spec(heavy[3]), spec(heavy[0], 1), spec(light[1]), spec(heavy[1])];
    const sorted = await sequencer({ index: 1, count: 2 }).sort(specs);
    expect(sorted.map(key)).toEqual([heavy[1], heavy[3], light[0], light[1], heavy[0]]);
  });

  it("keeps vitest's order without --shard", async () => {
    const specs = [spec(light[0]), spec(heavy[3]), spec(light[1]), spec(heavy[1])];
    expect((await sequencer().sort(specs)).map(key)).toEqual([light[0], heavy[3], light[1], heavy[1]]);
  });
});
